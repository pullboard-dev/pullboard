/** Shared registered-runner test tooling: the CLI launchers, plus the pure helpers re-exported from runner-tooling-helpers.js. */
import { realpathSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  runFixtureChild,
  startFixtureChild,
} from '../child.js';
import {
  TOOLING_SNAPSHOTS,
  committedToolingSnapshot,
} from './phases.js';

export {
  ROUND_TRIP_DEADLINES, TOOLING_SNAPSHOTS, awaitRoundTrip, cleanupToolingSnapshots, committedToolingSnapshot,
  fixtureResultContext, gateResult, git, phaseCounts, runThroughGate,
} from './phases.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** Spawn the exact checked-in CLI from a fixture checkout. */
export function cli(repo, env, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
}


/** Start the current CLI from the same clean committed tooling snapshot used by API fixtures. */
export function startToolingCli(repo, env, args, { toolingRoot = resolve(import.meta.dirname, '../../../../..'), ...options } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const bin = join(committedToolingSnapshot(sourceRoot, env), 'apps/cli/pullboard.js');
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  try {
    const child = startFixtureChild(process.execPath, [bin, ...args], {
      cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], ...options,
    });
    let settled = false;
    const finish = (status, signal, failed) => {
      if (settled) return;
      settled = true;
      snapshot.active--;
      if (failed || status !== 0 || signal) snapshot.retained = true;
    };
    child.once('close', (status, signal) => finish(status, signal, false));
    child.once('error', () => finish(null, null, true));
    return child;
  } catch (error) {
    snapshot.active--;
    snapshot.retained = true;
    throw error;
  }
}
