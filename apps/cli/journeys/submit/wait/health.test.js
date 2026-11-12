/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { scanHealthSentinel } from '../../../../../packages/sentinels/index.js';
import { firstRefusal } from '../../../../../packages/store/index.js';

import { waitKit } from '../../../tests/fixtures/submit/wait.js';

const { helpers, onBoard, waitingVerdict, waitPorts } = waitKit(store);
after(helpers.cleanup);

/** Revision and episode guards both protect a builder who already reclaimed the rejected work. */
test('a reclaimed reject refuses both stale and retargeted health observations [B13,H16]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  const rejected = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject'));
  const now = new Date(Date.parse(rejected.event_at) + 1000);
  const clock = { now: () => now };
  const observation = scanHealthSentinel(join(box.repo, '.git/pullboard/board.sqlite'),
    { root: box.repo, config: loadConfig(box.repo), now, returnRejected: true });
  onBoard(box, board => {
    const builder = store.getItem(board, 1).item_built_by;
    store.claim(board, 1, { agentId: builder, lane: 'web', leaseMs: 60_000 });
    const before = exportBoard(board);
    assert.throws(() => store.recordHealthFindings(board, { agentId: 'coordinator', ...observation }),
      error => error.code === 'HEALTH_SCAN_STALE');
    assert.deepEqual(exportBoard(board), before);
    const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    assert.throws(() => store.recordHealthFindings(board, { agentId: 'coordinator', ...observation, observedRevision }),
      error => error.code === 'HEALTH_SCAN_STALE');
    assert.deepEqual(exportBoard(board), before, 'updating only the revision cannot retarget the old rejection');
    assert.equal(store.getItem(board, 1).item_owner, builder);
  }, clock);
});

/** The existing public coordinator scan, rather than a direct test-only move, performs the handback. */
test('clause 1: the public coordinator health scan returns an inactive reject to the queue [B13,A6]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  assert.equal(onBoard(box, board => firstRefusal(board, 1)), null, 'a rejection reserves nothing for the inactive builder');
  const ran = await box.runLocal(box.repo, 'sentinel', 'run', '--health-only', '--json');
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.ok(JSON.parse(ran.out).health.findings.some(finding => finding.cause === 'REWORK_UNCLAIMED' && finding.item === 1));
  onBoard(box, board => {
    assert.equal(firstRefusal(board, 1), null);
    assert.ok(store.events(board, { itemId: 1 }).some(event => event.event_kind === 'reject_returned'));
    assert.ok(store.allShouts(board).some(shout => shout.shout_to === 'coordinator'
      && shout.shout_text.includes('The fixture deliberately rejects this concrete clause.')));
  });
});
