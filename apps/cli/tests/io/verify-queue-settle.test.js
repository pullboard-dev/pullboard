/** A queued accept settles from its check job's receipt: green records the accept, red reopens the item with the failing reason [C7,V4,#3161]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { register } from '../../../../packages/store/index.js';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { submitFixture } from '../../../../packages/store/tests/fixtures/submit.js';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { claimJob } from '../../../../packages/api/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { reserveReview } from '../../../../packages/jobs/index.js';
import { reviewJobId } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';

const COMMIT = 'b'.repeat(40);
const DIGEST = 'fixture-bar';

/** A submitted item whose review is reserved to a reviewer and whose accept is queued on a check job, as `verify accept` leaves it. */
function queued(t) {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/repo' });
  const builder = register(board, { lane: 'core', path: '/builder', route: 'mid' });
  const reviewer = register(board, { lane: 'core', path: '/reviewer', route: 'mid' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Queued', criterion: 'prove it', specIds: ['C7'], route: 'mid', check: 'true',
    brief: 'Files: src/queued.js\nTest: proves queued' });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 60 * 60_000, freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: DIGEST }) });
  submitFixture(board, id, { agentId: builder, commit: COMMIT, tree: COMMIT });
  reserveReview(board.db, id, reviewer, { now: Date.now(), leaseMs: 60 * 60_000 });
  const checkJob = `test:${COMMIT.slice(0, 12)}:queued`;
  offerJob(board.db, { id: checkJob, kind: 'test', needs: [], item: id, candidate: COMMIT, base: COMMIT, now: 1, request: { run: ['true'], input: { data: {} } } });
  writeStep(board.db, reviewJobId(id), 'accept-queued', { checkJob, commit: COMMIT, main: COMMIT, digest: DIGEST, reviewer, policy: 'any' }, { seq: 1, now: 1 });
  return { board, id, checkJob, reviewer, builder };
}

/** The runner's post: claim the check job and post its one receipt. */
function post({ board, checkJob }, receipt) {
  const lease = claimJob(board.db, { runner: 'r-accept', capabilities: [], now: 2 });
  return boardJobQueueCall(board, { action: 'receipt', job: checkJob, runner: 'r-accept', token: lease.token, receipt }, { mode: 'pull', now: 3 });
}

test('cli.io-verify-queue-settle.a-queued-accept-is-recorded-when-its: clause 1: a queued accept is recorded when its check job passes [C7,V4]', t => {
  const f = queued(t);
  post(f, { status: 0, gate: { green: true, phases: [{ status: 0 }] } });
  const item = store.getItem(f.board, f.id);
  assert.equal(item.item_verdict, 'ACCEPT');
  assert.equal(item.item_verified_by, f.reviewer);
  assert.equal(item.item_status, 'verified');
});

test('cli.io-verify-queue-settle.a-queued-accept-reopens-the-item-to: clause 1: a queued accept reopens the item to its builder with the failing reason when its check job fails [C7,V4]', t => {
  const f = queued(t);
  post(f, { status: 1, gate: { green: false, phases: [{ status: 1, failures: [{ file: 'src/queued.test.js', name: 'it holds' }] }] } });
  const item = store.getItem(f.board, f.id);
  assert.equal(item.item_status, 'open');
  const notes = store.itemThread(f.board, f.id).map(fact => `${fact.text ?? ''} ${fact.note ?? ''} ${fact.detail ?? ''}`).join('\n');
  assert.match(notes + JSON.stringify(store.events(f.board, { itemId: f.id }).map(event => event.event_detail)), /src\/queued\.test\.js: it holds/u);
});
