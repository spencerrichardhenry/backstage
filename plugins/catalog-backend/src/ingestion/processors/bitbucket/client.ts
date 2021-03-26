/*
 * Copyright 2021 Spotify AB
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
import { Logger } from 'winston';
import fetch from 'cross-fetch';

import {
  BitbucketIntegrationConfig,
  getBitbucketRequestOptions,
} from '@backstage/integration';

export class BitbucketClient {
  private readonly config: BitbucketIntegrationConfig;
  private readonly logger: Logger;

  constructor(options: { config: BitbucketIntegrationConfig; logger: Logger }) {
    this.config = options.config;
    this.logger = options.logger;
  }

  async listProjects(options?: ListOptions): Promise<PagedResponse<any>> {
    return this.pagedRequest(`${this.config.apiBaseUrl}/projects`, options);
  }

  async listRepositories(
    projectKey: string,
    options?: ListOptions,
  ): Promise<PagedResponse<any>> {
    return this.pagedRequest(
      `${this.config.apiBaseUrl}/projects/${projectKey}/repos`,
      options,
    );
  }

  private async pagedRequest(
    endpoint: string,
    options?: ListOptions,
  ): Promise<PagedResponse<any>> {
    const request = new URL(endpoint);
    if (options) {
      (Object.keys(options) as Array<keyof typeof options>).forEach(key => {
        const value: any = options[key] as any;
        if (value) {
          request.searchParams.append(key, value);
        }
      });
    }
    const response = await fetch(
      request.toString(),
      getBitbucketRequestOptions(this.config),
    );
    if (!response.ok) {
      throw new Error(
        `Unexpected response when fetching ${request.toString()}. Expected 200 but got ${
          response.status
        } - ${response.statusText}`,
      );
    }
    return response.json().then(repositories => {
      return repositories as PagedResponse<any>;
    });
  }
}

export type ListOptions = {
  limit?: number | undefined;
  start?: number | undefined;
};

export type PagedResponse<T> = {
  size: number;
  limit: number;
  start: number;
  isLastPage: boolean;
  values: T[];
  nextPageStart: number;
};

export function pageIterator(
  pagedRequest: (options: ListOptions) => Promise<PagedResponse<any>>,
  options?: ListOptions,
): AsyncIterable<PagedResponse<any>> {
  return {
    [Symbol.asyncIterator]: () => {
      const opts = options || { start: 0 };
      let finished = false;
      return {
        async next() {
          if (!finished) {
            try {
              const response = await pagedRequest(opts);
              finished = response.isLastPage;
              opts.start = response.nextPageStart;
              return Promise.resolve({
                value: response,
                done: false,
              });
            } catch (error) {
              return Promise.reject({
                value: undefined,
                done: true,
                error: error,
              });
            }
          } else {
            opts.start = 0;
            finished = false;
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          }
        },
      };
    },
  };
}
