/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { firstRefusal } from '../../../../packages/store/index.js';

import { waitKit } from '../../tests/fixtures/submit/wait.js';

const { helpers, onBoard, waitingVerdict, waitPorts } = waitKit(store);
after(helpers.cleanup);

test('submit --wait ends at its gate, and a later unclaimed reject returns with its note [V2,V4,B5,B13,A6]', async t => {
  await waitingVerdict(t, 'ACCEPT');
  const box = await waitingVerdict(t, 'REJECT');
  const rejected = onBoard(box, board => store.events(board).findLast(event => event.event_kind === 'reject'));
  const start = Date.parse(rejected.event_at);
  let now = new Date(start + 10 * 60_000 - 1);
  const clock = { now: () => now };
  const nextPath = join(box.dir, 'next-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', nextPath, 'main');
  const nextActor = onBoard(box, board => store.register(board, { lane: 'web', path: nextPath }));
  const config = loadConfig(box.repo);
  // The window waits only for a builder who can come back; a gone seat's window ends at once (18a0128eb0, #3447).
  onBoard(box, board => heartbeatSeat(board, store.getItem(board, 1).item_built_by), clock);
  // A rejection reserves nothing since #4950: no builder window is sealed, so any seat could claim it at once.
  assert.equal(onBoard(box, board => firstRefusal(board, 1), clock), null, 'a rejection seals no builder window');
  const before = onBoard(box, board => healthReport({ dispatchHealth, db: board.db, root: box.repo, config, now }), clock);
  assert.ok(!before.stuck.some(finding => finding.item === 1 && finding.cause === 'REWORK_UNCLAIMED'),
    'the ten-minute boundary is not rounded down');
  now = new Date(start + 10 * 60_000);
  const due = onBoard(box, board => healthReport({ dispatchHealth, db: board.db, root: box.repo, config, now }), clock);
  const finding = due.stuck.find(entry => entry.item === 1 && entry.cause === 'REWORK_UNCLAIMED');
  assert.ok(finding, 'an unreclaimed reject interrupts the coordinator at ten minutes');
  assert.equal(finding.owner.who, 'coordinator');
  assert.ok(finding.why.includes('The fixture deliberately rejects this concrete clause.'), 'queue return retains the reviewer note');
  onBoard(box, board => {
    const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision, findings: due.stuck, returnRejected: true });
    const afterReturn = store.events(board).length;
    const currentRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: currentRevision,
      findings: due.stuck, returnRejected: true });
    assert.equal(store.events(board).length, afterReturn, 'an unchanged scan never returns or notifies twice');
    store.claim(board, 1, { agentId: nextActor, lane: 'web', leaseMs: 60_000 });
    assert.equal(store.getItem(board, 1).item_owner, nextActor, 'the next builder really receives the rejected item');
    assert.ok(store.verdictsFor(board, 1).some(entry => entry.verdict_decision === 'REJECT'
      && entry.verdict_note === 'The fixture deliberately rejects this concrete clause.'), 'return preserves the original rejection');
  }, clock);
});
