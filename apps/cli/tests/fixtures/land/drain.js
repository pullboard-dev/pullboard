import { spawnSync } from 'node:child_process';
import { waitForFixtureProgress } from '../progress.js';

/**
 * Wait until no process of this fixture is still running. Why: a landing leaves finishing work behind (audits, workers)
 * that runs a gate and takes a lease on its own clock, so counts read before it ends differ by load.
 */
export async function drainOwnedProcesses(directory) {
  const owned = () => spawnSync('pgrep', ['-f', directory], { encoding: 'utf8' }).stdout.trim();
  let last = owned(), changes = 0;
  /** Count every change in the owned pid set: a finishing process shrinks it, and that is progress too. */
  const progress = () => { const now = owned(); if (now !== last) { last = now; changes += 1; } return changes; };
  try {
    await waitForFixtureProgress({ child: { exitCode: null, signalCode: null }, ready: () => owned() === '',
      progress, description: 'fixture processes finishing', quietMs: 60_000 });
  } catch (error) {
    const pids = owned().split('\n').filter(Boolean).join(',');
    const listing = pids ? spawnSync('ps', ['-o', 'pid=,ppid=,etime=,command=', '-p', pids], { encoding: 'utf8' }).stdout : '';
    throw new Error(`${error.message}; still running:\n${listing}`, { cause: error });
  }
}
