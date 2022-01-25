/*
 * Copyright 2020 The Backstage Authors
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

import fs from 'fs-extra';
import chalk from 'chalk';
import semver from 'semver';
import minimatch from 'minimatch';
import { Command } from 'commander';
import { isError, NotFoundError } from '@backstage/errors';
import { resolve as resolvePath } from 'path';
import { run } from '../../lib/run';
import { paths } from '../../lib/paths';
import {
  mapDependencies,
  fetchPackageInfo,
  Lockfile,
  YarnInfoInspectData,
} from '../../lib/versioning';
import { forbiddenDuplicatesFilter } from './lint';
import { BACKSTAGE_JSON } from '@backstage/cli-common';
import {
  getByReleaseLine,
  getByVersion,
  ReleaseManifest,
} from '@backstage/release-manifest';

const DEP_TYPES = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const DEFAULT_PATTERN_GLOB = '@backstage/*';

type PkgVersionInfo = {
  range: string;
  target: string;
  name: string;
  location: string;
};

export default async (cmd: Command) => {
  const lockfilePath = paths.resolveTargetRoot('yarn.lock');
  const lockfile = await Lockfile.load(lockfilePath);
  let pattern = cmd.pattern;

  if (!pattern) {
    console.log(`Using default pattern glob ${DEFAULT_PATTERN_GLOB}`);
    pattern = DEFAULT_PATTERN_GLOB;
  } else {
    console.log(`Using custom pattern glob ${pattern}`);
  }

  let findTargetVersion: (name: string) => Promise<string>;
  if (semver.valid(cmd.release)) {
    findTargetVersion = createStrictVersionFinder({
      releaseManifest: await getByVersion({ version: cmd.release }),
    });
  } else {
    findTargetVersion = createVersionFinder({
      releaseLine: cmd.releaseLine,
      releaseManifest: await getByReleaseLine({
        releaseLine: cmd.release,
      }),
    });
  }

  // First we discover all Backstage dependencies within our own repo
  const dependencyMap = await mapDependencies(paths.targetDir, pattern);

  // Next check with the package registry to see which dependency ranges we need to bump
  const versionBumps = new Map<string, PkgVersionInfo[]>();
  // Track package versions that we want to remove from yarn.lock in order to trigger a bump
  const unlocked = Array<{ name: string; range: string; target: string }>();
  await workerThreads(16, dependencyMap.entries(), async ([name, pkgs]) => {
    let target: string;
    try {
      target = await findTargetVersion(name);
    } catch (error) {
      if (isError(error) && error.name === 'NotFoundError') {
        console.log(`${error.message}, skipping`);
        return;
      }
      throw error;
    }

    for (const pkg of pkgs) {
      if (semver.satisfies(target, pkg.range)) {
        if (semver.minVersion(pkg.range)?.version !== target) {
          unlocked.push({ name, range: pkg.range, target });
        }

        continue;
      }
      versionBumps.set(
        pkg.name,
        (versionBumps.get(pkg.name) ?? []).concat({
          name,
          location: pkg.location,
          range: `^${target}`, // TODO(Rugvip): Option to use something else than ^?
          target,
        }),
      );
    }
  });

  const filter = (name: string) => minimatch(name, pattern);

  // Check for updates of transitive backstage dependencies
  await workerThreads(16, lockfile.keys(), async name => {
    // Only check @backstage packages and friends, we don't want this to do a full update of all deps
    if (!filter(name)) {
      return;
    }

    let target: string;
    try {
      target = await findTargetVersion(name);
    } catch (error) {
      if (isError(error) && error.name === 'NotFoundError') {
        console.log(`${error.message}, skipping`);
        return;
      }
      throw error;
    }

    for (const entry of lockfile.get(name) ?? []) {
      // Ignore lockfile entries that don't satisfy the version range, since
      // these can't cause the package to be locked to an older version
      if (!semver.satisfies(target, entry.range)) {
        continue;
      }
      // Unlock all entries that are within range but on the old version
      unlocked.push({ name, range: entry.range, target });
    }
  });

  console.log();

  // Write all discovered version bumps to package.json in this repo
  if (versionBumps.size === 0 && unlocked.length === 0) {
    console.log(chalk.green('All Backstage packages are up to date!'));
  } else {
    console.log(chalk.yellow('Some packages are outdated, updating'));
    console.log();

    if (unlocked.length > 0) {
      const removed = new Set<string>();
      for (const { name, range, target } of unlocked) {
        // Don't bother removing lockfile entries if they're already on the correct version
        const existingEntry = lockfile.get(name)?.find(e => e.range === range);
        if (existingEntry?.version === target) {
          continue;
        }
        const key = JSON.stringify({ name, range });
        if (!removed.has(key)) {
          removed.add(key);
          console.log(
            `${chalk.magenta('unlocking')} ${name}@${chalk.yellow(
              range,
            )} ~> ${chalk.yellow(target)}`,
          );
          lockfile.remove(name, range);
        }
      }
      await lockfile.save();
    }

    const breakingUpdates = new Map<string, { from: string; to: string }>();
    await workerThreads(16, versionBumps.entries(), async ([name, deps]) => {
      const pkgPath = resolvePath(deps[0].location, 'package.json');
      const pkgJson = await fs.readJson(pkgPath);

      for (const dep of deps) {
        console.log(
          `${chalk.cyan('bumping')} ${dep.name} in ${chalk.cyan(
            name,
          )} to ${chalk.yellow(dep.range)}`,
        );

        for (const depType of DEP_TYPES) {
          if (depType in pkgJson && dep.name in pkgJson[depType]) {
            const oldRange = pkgJson[depType][dep.name];
            pkgJson[depType][dep.name] = dep.range;

            // Check if the update was at least a pre-v1 minor or post-v1 major release
            const lockfileEntry = lockfile
              .get(dep.name)
              ?.find(entry => entry.range === oldRange);
            if (lockfileEntry) {
              const from = lockfileEntry.version;
              const to = dep.target;
              if (!semver.satisfies(to, `^${from}`)) {
                breakingUpdates.set(dep.name, { from, to });
              }
            }
          }
        }
      }

      await fs.writeJson(pkgPath, pkgJson, { spaces: 2 });
    });

    console.log();

    await bumpBackstageJsonVersion();

    console.log();
    console.log(
      `Running ${chalk.blue('yarn install')} to install new versions`,
    );
    console.log();
    await run('yarn', ['install']);

    if (breakingUpdates.size > 0) {
      console.log();
      console.log(
        chalk.yellow('⚠️  The following packages may have breaking changes:'),
      );
      console.log();

      for (const [name, { from, to }] of Array.from(
        breakingUpdates.entries(),
      ).sort()) {
        console.log(
          `  ${chalk.yellow(name)} : ${chalk.yellow(from)} ~> ${chalk.yellow(
            to,
          )}`,
        );

        let path;
        if (name.startsWith('@backstage/plugin-')) {
          path = `plugins/${name.replace('@backstage/plugin-', '')}`;
        } else if (name.startsWith('@backstage/')) {
          path = `packages/${name.replace('@backstage/', '')}`;
        }
        if (path) {
          // TODO(Rugvip): Grab these URLs and paths from package.json, possibly verify existence
          //               Possibly invent new "changelog" field in package.json or some sh*t.
          console.log(
            `    https://github.com/backstage/backstage/blob/master/${path}/CHANGELOG.md`,
          );
        }
        console.log();
      }
    } else {
      console.log();
    }

    console.log(chalk.green('Version bump complete!'));
  }

  console.log();

  // Finally we make sure the new lockfile doesn't have any duplicates
  const dedupLockfile = await Lockfile.load(lockfilePath);
  const result = dedupLockfile.analyze({
    filter,
  });

  if (result.newVersions.length > 0) {
    throw new Error('Duplicate versions present after package bump');
  }

  const forbiddenNewRanges = result.newRanges.filter(({ name }) =>
    forbiddenDuplicatesFilter(name),
  );
  if (forbiddenNewRanges.length > 0) {
    throw new Error(
      `Version bump failed for ${forbiddenNewRanges
        .map(i => i.name)
        .join(', ')}`,
    );
  }
};

export function createStrictVersionFinder(options: {
  releaseManifest: ReleaseManifest;
}) {
  const releasePackages = new Map(
    options.releaseManifest.packages.map(p => [p.name, p.version]),
  );
  return async function findTargetVersion(name: string) {
    console.log(`Checking for updates of ${name}`);
    const manifestVersion = releasePackages.get(name);
    if (manifestVersion) {
      return manifestVersion;
    }
    throw new NotFoundError(`Package ${name} not found in release manifest`);
  };
}

export function createVersionFinder(options: {
  releaseLine?: string;
  packageInfoFetcher?: () => Promise<YarnInfoInspectData>;
  releaseManifest: ReleaseManifest;
}) {
  const {
    releaseLine = 'latest',
    packageInfoFetcher = fetchPackageInfo,
    releaseManifest,
  } = options;
  // The main release line is just an alias for latest
  const distTag = releaseLine === 'main' ? 'latest' : releaseLine;
  const found = new Map<string, string>();
  const releasePackages = new Map(
    releaseManifest.packages.map(p => [p.name, p.version]),
  );
  return async function findTargetVersion(name: string) {
    const existing = found.get(name);
    if (existing) {
      return existing;
    }

    console.log(`Checking for updates of ${name}`);
    const manifestVersion = releasePackages.get(name);
    if (manifestVersion) {
      return manifestVersion;
    }

    const info = await packageInfoFetcher(name);
    const latestVersion = info['dist-tags'].latest;
    if (!latestVersion) {
      throw new Error(`No target 'latest' version found for ${name}`);
    }

    const taggedVersion = info['dist-tags'][distTag];
    if (distTag === 'latest' || !taggedVersion) {
      found.set(name, latestVersion);
      return latestVersion;
    }

    const latestVersionDateStr = info.time[latestVersion];
    const taggedVersionDateStr = info.time[taggedVersion];
    if (!latestVersionDateStr) {
      throw new Error(
        `No time available for version '${latestVersion}' of ${name}`,
      );
    }
    if (!taggedVersionDateStr) {
      throw new Error(
        `No time available for version '${taggedVersion}' of ${name}`,
      );
    }

    const latestVersionRelease = new Date(latestVersionDateStr).getTime();
    const taggedVersionRelease = new Date(taggedVersionDateStr).getTime();
    if (latestVersionRelease > taggedVersionRelease) {
      // Prefer latest version if it's newer.
      found.set(name, latestVersion);
      return latestVersion;
    }

    found.set(name, taggedVersion);
    return taggedVersion;
  };
}

export async function bumpBackstageJsonVersion() {
  const backstageJsonPath = paths.resolveTargetRoot(BACKSTAGE_JSON);
  const backstageJson = await fs.readJSON(backstageJsonPath).catch(e => {
    if (e.code === 'ENOENT') {
      // gracefully continue in case the file doesn't exist
      return;
    }
    throw e;
  });

  const info = await fetchPackageInfo('@backstage/create-app');
  const { latest } = info['dist-tags'];

  if (backstageJson?.version === latest) {
    return;
  }

  console.log(
    chalk.yellow(
      typeof backstageJson === 'undefined'
        ? `Creating ${BACKSTAGE_JSON}`
        : `Bumping version in ${BACKSTAGE_JSON}`,
    ),
  );

  await fs.writeJson(
    backstageJsonPath,
    { ...backstageJson, version: latest },
    {
      spaces: 2,
      encoding: 'utf8',
    },
  );
}

async function workerThreads<T>(
  count: number,
  items: IterableIterator<T>,
  fn: (item: T) => Promise<void>,
) {
  const queue = Array.from(items);

  async function pop() {
    const item = queue.pop();
    if (!item) {
      return;
    }

    await fn(item);
    await pop();
  }

  return Promise.all(
    Array(count)
      .fill(0)
      .map(() => pop()),
  );
}
