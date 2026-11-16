/** The ownership-routing assertion shared by the policy journeys that submit foreign paths [B3,L1,V4,C7]. */
import assert from 'node:assert/strict';
import { whenRunnerSettles } from '../runner/local-start.js';
import { settleSubmit } from './settle.js';

/**
 * Assert a green submit routed only foreign paths to their owner: the builder is freed and nothing is submitted (B3,L1,V4).
 *
 * Why: the ownership routing (814a7def2a) replaced the immediate OUTSIDE_LANE refusal for proved foreign paths; the owner decides.
 */
export async function assertWaitsOnOwner(t, box, id, submitted, paths, label = '') {
  assert.equal(submitted.code, 0, `${label} ${submitted.out}${submitted.err}`);
  // The pulled gate settles red on the ownership refusal; the hold is applied a moment later, so settle on it [P7].
  const settled = await settleSubmit(t, box, JSON.parse(submitted.out));
  assert.equal(settled.gate.analysis.ownership?.code, 'OUTSIDE_LANE', `${label}: the pulled gate analysis names the ownership refusal`);
  const item = await whenRunnerSettles(box.env, async () => {
    const row = JSON.parse((await box.inProcess(box.repo, 'show', String(id), '--json')).out);
    return row.item_hold_reason ? row : null;
  }, { deadlineMs: 120_000, what: `the owner routing of #${id} ${label}` });
  assert.equal(item.item_status, 'open', label);
  assert.equal(item.item_commit, null, `${label}: owner waiting is not a submission`);
  assert.match(item.item_hold_reason, /^waiting on ownership /u, label);
  // The hold names only a digest; owner and paths are in the thread's ownership-wait event.
  const waiting = (item.thread ?? []).findLast(row => row.kind === 'ownership-wait')?.detail;
  assert.ok(waiting, `${label}: the thread records the ownership wait`);
  assert.deepEqual(waiting.owners, ['coordinator'], label);
  for (const path of paths) assert.equal(waiting.paths.includes(path), true, `${label} ${path}`);
}
