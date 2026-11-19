/** Start a cell script as a node entry file and return its exit status and error text (#11709) [C7]. */
import { spawnSync } from 'node:child_process';

/** Run one script by the given path the way the review worker is started: node <script> <args>. */
export function startAsEntry(script, args, timeout = 30_000) {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout });
  return { status: run.status, stderr: run.stderr ?? '' };
}
