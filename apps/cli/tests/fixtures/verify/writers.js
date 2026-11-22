/** Drain the review comparison writers a private fixture root recorded, then remove that root once [V15,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFixtureChild } from '../child.js';
import { waitForCondition } from '../runner/holders.js';

/** Whether any process of the group still exists; only "no such group" reads as gone, every other error is raised. */
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** The leader's command line, or null when no process holds that pid; a failed listing is raised, never read as empty. */
function leaderArgs(pid) {
  const shown = runFixtureChild('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  if (shown.status === 1 && !shown.stdout.trim()) return null;
  assert.equal(shown.status, 0, `ps lists comparison worker ${pid}: ${shown.stderr}`);
  return shown.stdout.trim();
}

/**
 * The live comparison worker groups recorded under a fixture root: each repository one level down keeps its jobs in
 * .git/pullboard/review-comparisons/<job>, and the launcher records the detached worker, which leads its own process
 * group, in worker.json. A worker counts as the root's own only when its command line names that job's request.json;
 * once its leader has exited, a group still alive under that id is the worker's orphaned children, since a pid is not
 * handed out again while a group of that id exists. result.json does not end ownership: the worker writes it before it exits.
 *
 * @param {string} root - The private fixture root.
 * @returns {number[]} The process group ids of the root's live comparison workers.
 */
export function ownedComparisonGroups(root) {
  const groups = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const base = join(root, entry.name, '.git', 'pullboard', 'review-comparisons');
    if (!entry.isDirectory() || !existsSync(base)) continue;
    for (const job of readdirSync(base)) {
      const record = join(base, job, 'worker.json');
      // No record means no worker was launched for this job; a malformed one is raised.
      if (!existsSync(record)) continue;
      const pid = Number(JSON.parse(readFileSync(record, 'utf8')).pid);
      assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, `${record} names a worker pid`);
      if (!groupAlive(pid)) continue;
      const args = leaderArgs(pid);
      if (args === null || args.includes(join(base, job, 'request.json'))) groups.push(pid);
    }
  }
  return groups;
}

/**
 * Stop the root's own comparison writers, await the exit of each whole group, then remove the root in one call.
 * Why: the pulled gate's comparison worker is detached from the killed local runner and keeps writing into the repo's
 * .git/pullboard and its Node compile cache until it exits, so an immediate removal raced it with ENOTEMPTY (#12007,
 * #12918). A writer still alive when the test's signal ends fails the case and keeps the root; the removal is never retried.
 *
 * @param {string} root - The private fixture root.
 * @param {{ signal?: AbortSignal }} [options] - The calling test's signal, which bounds the wait.
 * @returns {Promise<number[]>} The process groups that were drained.
 */
export async function removeDrainedFixture(root, { signal } = {}) {
  const groups = ownedComparisonGroups(root);
  for (const pgid of groups) {
    try { process.kill(-pgid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // An async wait lets this process reap a worker it started itself, so an exited child is not read as alive.
  await waitForCondition(() => !groups.some(groupAlive), 'every comparison writer the fixture recorded has exited before its root is removed',
    { signal, state: () => groups.filter(groupAlive) });
  rmSync(root, { recursive: true, force: true });
  return groups;
}
