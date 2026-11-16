/** One prepared runner per test process: the worker folder and runner home every SSH stand-in case runs in [C7,#8262]. */
import {
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

/** What a runner keeps between jobs: its keyed caches and cloned repos, each rebuilt from its key if lost. */
const KEPT = new Set(['cache', 'repos']);

let prepared = null;
let builds = 0;
let uses = 0;

/** Remove everything in `folder` except the names `keep` holds. */
function clearFolder(folder, keep = new Set()) {
  let names = [];
  try { names = readdirSync(folder); } catch { return; /* Nothing there yet. */ }
  for (const name of names) if (!keep.has(name)) rmSync(join(folder, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * The test process's one prepared runner, reset for the next case: its worker folder and machine home are emptied and
 * its runner folder keeps only the keyed caches and repos, so a case sees no job, request or hold of an earlier one.
 * Why: each case used to make its own worker and home, so every case paid a cold first trip (about 34 s) that the
 * runner's shared caches (#8233) could only help across jobs of one runner; one runner per process warms once.
 *
 * @param {() => string} newRoot Makes the runner's private root folder; called once per process, by a shared fixture helper.
 * @returns {{ worker: string, home: string, machineHome: string, uses: number }} Folders to give installSshStandIn.
 */
export function preparedRunner(newRoot) {
  if (!prepared) {
    const root = newRoot();
    prepared = { root, worker: join(root, 'worker'), home: join(root, 'remote-home'), machineHome: join(root, 'remote-home', '.pullboard') };
    process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* the temporary folder sweep takes it */ } });
    builds++;
  } else {
    clearFolder(prepared.worker);
    clearFolder(prepared.machineHome);
    clearFolder(join(prepared.home, '.pullboard-runner'), KEPT);
  }
  for (const folder of [prepared.worker, prepared.home, prepared.machineHome]) mkdirSync(folder, { recursive: true });
  uses++;
  return { worker: prepared.worker, home: prepared.home, machineHome: prepared.machineHome, uses };
}

/** How many runners this process prepared and how many cases took one: a process with N cases builds 1 and uses N. */
export function preparedRunnerCounts() {
  return { builds, uses };
}
