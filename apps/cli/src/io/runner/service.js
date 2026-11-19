/**
 * The program an installed runner service runs: `pullboard runner serve` without the rest of the CLI, so a runner holds
 * only this file and what it imports [P7]. `pullboard runner install-serve` copies them to the runner and starts it as a
 * login service that restarts on exit.
 *
 * Usage: node service.js <board-url> <key-file> <cache-directory> [<hint>]
 * The hint is what install-serve says to log when the board stays unreachable: the likely macOS block and its fix.
 */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRunner } from '../../../../../packages/drive/index.js';
import { runnerSettingNumber } from '../../../../../packages/drive/index.js';
import { runnerSettingOn } from '../../../../../packages/drive/index.js';
import { machineSettingsFile } from '../../../../../packages/resources/light.js';
import { pullGit } from './git.js';

/** A pulled land job, as `pullboard runner serve` runs it: merge, check and push trunk by compare-and-swap in the cache [P7]. */
async function land(claim, { cache, renew, env }) {
  const { runLandingJob } = await import('../../../../../packages/landing/index.js');
  const { asyncFetchEnabled } = await import('../../../../../packages/config/index.js');
  return runLandingJob(claim.payload, { workdir: join(cache, 'land'), renew, env, asyncFetch: asyncFetchEnabled() });
}

/**
 * The runnerCode port for this install folder, built only with runners.selfUpdate on (default off: no port, as today) [P7,#10825].
 * The app folder is the one this entry runs from; the trunk store is the pull cache's own git directory.
 */
async function codePort(cache) {
  if (!runnerSettingOn(machineSettingsFile(), 'runners.selfUpdate')) return null;
  const { runnerCodeRefresh } = await import('../../../../../packages/landing/index.js');
  return runnerCodeRefresh({ app: resolve(import.meta.dirname, '../../../../..'), store: join(cache, 'git') });
}

/**
 * Serve until stopped and return the exit code: 0 when serveRunner asked for a restart onto new runner code (the service
 * manager's KeepAlive starts it) or stopped plainly, 1 on a refusal, and 1 before serving when PULLBOARD_RUNNER_JOBS is unset.
 */
export async function runService(argv, { serve = serveRunner, port = codePort, out = line => process.stdout.write(line), signal = new AbortController().signal, env = process.env } = {}) {
  const [board, keyFile, cache, hint] = argv;
  const say = line => out(`${new Date().toISOString()} ${line}\n`);
  // The installed service takes its slot count from install-serve, so a start without it would fall to a cores-based default and starve gates [P7].
  if (env.PULLBOARD_RUNNER_JOBS === undefined || env.PULLBOARD_RUNNER_JOBS === '') {
    say('stopped: PULLBOARD_RUNNER_JOBS is not set; run pullboard runner install-serve <host> --board <url> again, which writes it');
    return 1;
  }
  try {
    say(`runner serve pulling from ${board}`);
    const runnerCode = await port(cache);
    const served = await serve({ board, key: fileSystemAdapter().readFile(keyFile).trim(), cache, handlers: { land }, git: pullGit, signal, say, unreachableHint: hint,
      fetchFailFast: runnerSettingOn(machineSettingsFile(), 'runners.fetchFailFast'), drainOnFetchFailure: runnerSettingOn(machineSettingsFile(), 'runners.drainOnFetchFailure'),
      fetchConcurrent: runnerSettingOn(machineSettingsFile(), 'runners.fetchConcurrent'),
      pruneYields: runnerSettingOn(machineSettingsFile(), 'runners.yieldWhilePruning'), handBackUnrunnable: runnerSettingOn(machineSettingsFile(), 'jobs.handBackUnrunnable'),
      postedLineNamesCase: runnerSettingOn(machineSettingsFile(), 'runners.postedLineNamesCase'), jobWorkerFactor: runnerSettingNumber(machineSettingsFile(), 'runners.jobWorkerFactor', 2),
      pulledProfilePaths: (await import('../../../../../packages/config/index.js')).pulledProfilePathsEnabled(),
      ...(runnerCode ? { runnerCode } : {}) });
    if (served?.restart) say(`runner code changed to ${served.restart}; exiting so the service manager starts it`);
    return 0;
  } catch (error) {
    // An exit is a restart: the service manager starts it again, so a refusal is logged with its code and nothing is lost.
    say(`stopped: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`);
    return 1;
  }
}

// Only as the service program, so a test can import runService.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stop.abort());
  process.exit(await runService(process.argv.slice(2), { signal: stop.signal }));
}
