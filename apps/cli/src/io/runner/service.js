/**
 * The program an installed runner service runs: `pullboard runner serve` without the rest of the CLI, so a runner holds
 * only this file and what it imports [P7]. `pullboard runner install-serve` copies them to the runner and starts it as a
 * login service that restarts on exit.
 *
 * Usage: node service.js <board-url> <key-file> <cache-directory> [<hint>]
 * The hint is what install-serve says to log when the board stays unreachable: the likely macOS block and its fix.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveRunner } from '../../../../../packages/drive/index.js';
import { runnerSettingOn } from '../../../../../packages/drive/index.js';
import { machineSettingsFile } from '../../../../../packages/resources/light.js';
import { pullGit } from './git.js';

/** A pulled land job, as `pullboard runner serve` runs it: merge, check and push trunk by compare-and-swap in the cache [P7]. */
async function land(claim, { cache, renew, env }) {
  const { runLandingJob } = await import('../../../../../packages/landing/index.js');
  return runLandingJob(claim.payload, { workdir: join(cache, 'land'), renew, env });
}

const [board, keyFile, cache, hint] = process.argv.slice(2);
const stop = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stop.abort());
const say = line => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
try {
  say(`runner serve pulling from ${board}`);
  await serveRunner({ board, key: readFileSync(keyFile, 'utf8').trim(), cache, handlers: { land }, git: pullGit, signal: stop.signal, say, unreachableHint: hint,
    fetchFailFast: runnerSettingOn(machineSettingsFile(), 'runners.fetchFailFast'), drainOnFetchFailure: runnerSettingOn(machineSettingsFile(), 'runners.drainOnFetchFailure'),
    pruneYields: runnerSettingOn(machineSettingsFile(), 'runners.yieldWhilePruning'),
    postedLineNamesCase: runnerSettingOn(machineSettingsFile(), 'runners.postedLineNamesCase') });
} catch (error) {
  // An exit is a restart: the service manager starts it again, so a refusal is logged with its code and nothing is lost.
  say(`stopped: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`);
  process.exitCode = 1;
}
