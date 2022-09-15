/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ScmIntegrations } from '@backstage/integration';
import { TaskContext, WorkflowResponse, WorkflowRunner } from './types';
import * as winston from 'winston';
import fs from 'fs-extra';
import path from 'path';
import nunjucks from 'nunjucks';
import { JsonObject, JsonValue } from '@backstage/types';
import { InputError } from '@backstage/errors';
import { PassThrough } from 'stream';
import { generateExampleOutput, isTruthy } from './helper';
import { validate as validateJsonSchema } from 'jsonschema';
import { parseRepoUrl } from '../actions/builtin/publish/util';
import { TemplateAction, TemplateActionRegistry } from '../actions';
import {
  TemplateFilter,
  SecureTemplater,
  SecureTemplateRenderer,
} from '../../lib/templating/SecureTemplater';
import {
  TaskSpec,
  TaskSpecV1beta3,
  TaskStep,
} from '@backstage/plugin-scaffolder-common';
import {
  createCounterMetric,
  createHistogramMetric,
} from '../../../../catalog-backend/src/util/metrics';

type NunjucksWorkflowRunnerOptions = {
  workingDirectory: string;
  actionRegistry: TemplateActionRegistry;
  integrations: ScmIntegrations;
  logger: winston.Logger;
  additionalTemplateFilters?: Record<string, TemplateFilter>;
};

type TemplateContext = {
  parameters: JsonObject;
  steps: {
    [stepName: string]: { output: { [outputName: string]: JsonValue } };
  };
  secrets?: Record<string, string>;
  user?: {};
};

const isValidTaskSpec = (taskSpec: TaskSpec): taskSpec is TaskSpecV1beta3 => {
  return taskSpec.apiVersion === 'scaffolder.backstage.io/v1beta3';
};

const createStepLogger = ({
  task,
  step,
}: {
  task: TaskContext;
  step: TaskStep;
}) => {
  const metadata = { stepId: step.id };
  const taskLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      winston.format.simple(),
    ),
    defaultMeta: {},
  });

  const streamLogger = new PassThrough();
  streamLogger.on('data', async data => {
    const message = data.toString().trim();
    if (message?.length > 1) {
      await task.emitLog(message, metadata);
    }
  });

  taskLogger.add(new winston.transports.Stream({ stream: streamLogger }));

  return { taskLogger, streamLogger };
};

export class NunjucksWorkflowRunner implements WorkflowRunner {
  constructor(private readonly options: NunjucksWorkflowRunnerOptions) {}
  private readonly tracker = scaffoldingTracker();

  private isSingleTemplateString(input: string) {
    const { parser, nodes } = nunjucks as unknown as {
      parser: {
        parse(
          template: string,
          ctx: object,
          options: nunjucks.ConfigureOptions,
        ): { children: { children?: unknown[] }[] };
      };
      nodes: { TemplateData: Function };
    };

    const parsed = parser.parse(
      input,
      {},
      {
        autoescape: false,
        tags: {
          variableStart: '${{',
          variableEnd: '}}',
        },
      },
    );

    return (
      parsed.children.length === 1 &&
      !(parsed.children[0]?.children?.[0] instanceof nodes.TemplateData)
    );
  }

  private render<T>(
    input: T,
    context: TemplateContext,
    renderTemplate: SecureTemplateRenderer,
  ): T {
    return JSON.parse(JSON.stringify(input), (_key, value) => {
      try {
        if (typeof value === 'string') {
          try {
            if (this.isSingleTemplateString(value)) {
              // Lets convert ${{ parameters.bob }} to ${{ (parameters.bob) | dump }} so we can keep the input type
              const wrappedDumped = value.replace(
                /\${{(.+)}}/g,
                '${{ ( $1 ) | dump }}',
              );

              // Run the templating
              const templated = renderTemplate(wrappedDumped, context);

              // If there's an empty string returned, then it's undefined
              if (templated === '') {
                return undefined;
              }

              // Reparse the dumped string
              return JSON.parse(templated);
            }
          } catch (ex) {
            this.options.logger.error(
              `Failed to parse template string: ${value} with error ${ex.message}`,
            );
          }

          // Fallback to default behaviour
          const templated = renderTemplate(value, context);

          if (templated === '') {
            return undefined;
          }

          return templated;
        }
      } catch {
        return value;
      }
      return value;
    });
  }

  async execute(task: TaskContext): Promise<WorkflowResponse> {
    if (!isValidTaskSpec(task.spec)) {
      throw new InputError(
        'Wrong template version executed with the workflow engine',
      );
    }
    const workspacePath = path.join(
      this.options.workingDirectory,
      await task.getWorkspaceName(),
    );

    const { integrations } = this.options;
    const renderTemplate = await SecureTemplater.loadRenderer({
      // TODO(blam): let's work out how we can deprecate this.
      // We shouldn't really need to be exposing these now we can deal with
      // objects in the params block.
      // Maybe we can expose a new RepoUrlPicker with secrets for V3 that provides an object already.
      parseRepoUrl(url: string) {
        return parseRepoUrl(url, integrations);
      },
      additionalTemplateFilters: this.options.additionalTemplateFilters,
    });

    let taskTrack;

    try {
      taskTrack = await this.tracker.taskStart(task);
      await fs.ensureDir(workspacePath);

      const context: TemplateContext = {
        parameters: task.spec.parameters,
        steps: {},
        user: task.spec.user,
      };

      for (const step of task.spec.steps) {
        const stepTrack = await this.tracker.stepStart(task, step);
        try {
          if (step.if) {
            const ifResult = await this.render(
              step.if,
              context,
              renderTemplate,
            );
            if (!isTruthy(ifResult)) {
              await stepTrack.skipFalsy();
              continue;
            }
          }

          const action = this.options.actionRegistry.get(step.action);
          const { taskLogger, streamLogger } = createStepLogger({ task, step });

          if (task.isDryRun && !action.supportsDryRun) {
            await taskTrack.skipDryRun(step, action);
            const outputSchema = action.schema?.output;
            if (outputSchema) {
              context.steps[step.id] = {
                output: generateExampleOutput(outputSchema) as {
                  [name in string]: JsonValue;
                },
              };
            } else {
              context.steps[step.id] = { output: {} };
            }
            continue;
          }

          // Secrets are only passed when templating the input to actions for security reasons
          const input =
            (step.input &&
              this.render(
                step.input,
                { ...context, secrets: task.secrets ?? {} },
                renderTemplate,
              )) ??
            {};

          if (action.schema?.input) {
            const validateResult = validateJsonSchema(
              input,
              action.schema.input,
            );
            if (!validateResult.valid) {
              const errors = validateResult.errors.join(', ');
              throw new InputError(
                `Invalid input passed to action ${action.id}, ${errors}`,
              );
            }
          }

          const tmpDirs = new Array<string>();
          const stepOutput: { [outputName: string]: JsonValue } = {};

          await action.handler({
            input,
            secrets: task.secrets ?? {},
            logger: taskLogger,
            logStream: streamLogger,
            workspacePath,
            createTemporaryDirectory: async () => {
              const tmpDir = await fs.mkdtemp(
                `${workspacePath}_step-${step.id}-`,
              );
              tmpDirs.push(tmpDir);
              return tmpDir;
            },
            output(name: string, value: JsonValue) {
              stepOutput[name] = value;
            },
            templateInfo: task.spec.templateInfo,
          });

          // Remove all temporary directories that were created when executing the action
          for (const tmpDir of tmpDirs) {
            await fs.remove(tmpDir);
          }

          context.steps[step.id] = { output: stepOutput };

          await stepTrack.markSuccessful();
        } catch (err) {
          await taskTrack.markFailed(step, err);
          stepTrack.markFailed();
          throw err;
        }
      }

      const output = this.render(task.spec.output, context, renderTemplate);
      taskTrack.markSuccessful();

      return { output };
    } finally {
      if (workspacePath) {
        await fs.remove(workspacePath);
      }
    }
  }
}

function scaffoldingTracker() {
  const taskSuccesses = createCounterMetric({
    name: 'scaffolder_task_success_count',
    help: 'Count of succesful task runs',
    labelNames: ['template', 'invoker'],
  });
  const taskErrors = createCounterMetric({
    name: 'scaffolder_task_error_count',
    help: 'Count of failed task runs',
    labelNames: ['template', 'invoker'],
  });
  const taskDuration = createHistogramMetric({
    name: 'scaffolder_task_duration',
    help: 'Duration of a task run',
    labelNames: ['template', 'result'],
  });
  const stepSuccesses = createCounterMetric({
    name: 'scaffolder_step_success_count',
    help: 'Count of successful step runs',
    labelNames: ['name'],
  });
  const stepErrors = createCounterMetric({
    name: 'scaffolder_step_error_count',
    help: 'Count of failed step runs',
    labelNames: ['name'],
  });
  const stepDuration = createHistogramMetric({
    name: 'scaffolder_step_duration',
    help: 'Duration of a step runs',
    labelNames: ['name', 'result'],
  });

  async function taskStart(task: TaskContext) {
    await task.emitLog(`Starting up task with ${task.spec.steps.length} steps`);
    const template = task.spec.templateInfo?.entity?.metadata.name || '';
    const invoker = task.spec.user?.entity?.metadata.name || '';

    const taskTimer = taskDuration.startTimer({
      template,
    });

    async function skipDryRun(
      step: TaskStep,
      action: TemplateAction<JsonObject>,
    ) {
      task.emitLog(`Skipping because ${action.id} does not support dry-run`, {
        stepId: step.id,
        status: 'skipped',
      });
    }

    function markSuccessful() {
      taskSuccesses.inc({
        template,
        invoker,
      });
      taskTimer({ result: 'ok' });
    }

    async function markFailed(step: TaskStep, err: Error) {
      await task.emitLog(String(err.stack), {
        stepId: step.id,
        status: 'failed',
      });
      taskErrors.inc({
        template,
        invoker,
      });
      taskTimer({ result: 'failed' });
    }

    return {
      skipDryRun,
      markSuccessful,
      markFailed,
    };
  }

  async function stepStart(task: TaskContext, step: TaskStep) {
    await task.emitLog(`Beginning step ${step.name}`, {
      stepId: step.id,
      status: 'processing',
    });

    const stepTimer = stepDuration.startTimer({
      name: step.name,
    });

    async function markSuccessful() {
      await task.emitLog(`Finished step ${step.name}`, {
        stepId: step.id,
        status: 'completed',
      });
      stepSuccesses.inc({
        name: step.name,
      });
      stepTimer({ result: 'ok' });
    }

    function markFailed() {
      stepErrors.inc({
        name: step.name,
      });
      stepTimer({ result: 'failed' });
    }

    async function skipFalsy() {
      await task.emitLog(
        `Skipping step ${step.id} because it's if condition was false`,
        { stepId: step.id, status: 'skipped' },
      );
    }

    return {
      markSuccessful,
      markFailed,
      skipFalsy,
    };
  }

  return {
    taskStart,
    stepStart,
  };
}
