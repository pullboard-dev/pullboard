/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import { dispatchHealth } from '../../../../../packages/sentinels/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { healthReport } from '../../../../../packages/health/index.js';
import { heartbeatSeat } from '../../../../../packages/store/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyRelayMove,
} from '../../../../../packages/state/index.js';
import { REJECTED_WORK_RETURN_ENGINE } from '../../../../../packages/state/light.js';
import { scanHealthSentinel } from '../../../../../packages/sentinels/index.js';
import { firstRefusal } from '../../../../../packages/store/index.js';

import { waitKit } from '../../../tests/fixtures/submit/wait.js';

const { helpers, onBoard, waitingVerdict, waitPorts } = waitKit(store);
after(helpers.cleanup);

/** An already-gone builder returns immediately; only the coordinator can authorize that observation. */
test('an inactive builder returns its rejected item before ten minutes [B13,A6,H2]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  const rejected = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject'));
  const now = new Date(Date.parse(rejected.event_at) + 1000);
  const clock = { now: () => now };
  const config = loadConfig(box.repo);
  const due = onBoard(box, board => healthReport({ dispatchHealth, db: board.db, root: box.repo, config, now }), clock);
  assert.ok(due.stuck.some(entry => entry.item === 1 && entry.detail.reason === 'inactive'));
  const nextPath = join(box.dir, 'replacement-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', nextPath, 'main');
  const nextActor = onBoard(box, board => store.register(board, { lane: 'web', path: nextPath }));
  onBoard(box, board => {
    const revision = () => board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    const before = revision();
    assert.throws(() => store.recordHealthFindings(board, { agentId: nextActor, observedRevision: before,
      findings: due.stuck, returnRejected: true }), error => error.code === 'COORDINATOR_ONLY');
    assert.equal(revision(), before, 'unauthorized return appends no event');
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: before,
      findings: due.stuck, returnRejected: true });
    const returned = store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject_returned');
    const detail = JSON.parse(returned.event_detail);
    assert.equal(detail.rejection, rejected.event_id);
    assert.equal(detail.reason, 'inactive');
    assert.ok(detail.note.includes('deliberately rejects'));
    store.claim(board, 1, { agentId: nextActor, lane: 'web', leaseMs: 60_000 });
    assert.equal(store.getItem(board, 1).item_owner, nextActor);
  }, clock);
});

/** Replica-local liveness cannot rewrite an already authenticated inactive-seat observation. */
test('an unattended reject return replays across different local heartbeats [B13,H2,H16]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  const rejected = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject'));
  const now = new Date(Date.parse(rejected.event_at) + 1000);
  const clock = { now: () => now };
  const config = loadConfig(box.repo);
  const observation = scanHealthSentinel(join(box.repo, '.git/pullboard/board.sqlite'),
    { root: box.repo, config, now, returnRejected: true });
  assert.ok(observation);
  const document = onBoard(box, board => exportBoard(board));
  const move = onBoard(box, board => prepareEngineMove(board, 'recordHealthFindings',
    [{ agentId: 'coordinator', ...observation }], { id: 'unattended-reject-fixture', actor: 'coordinator' }), clock);
  const copies = ['live', 'gone'].map(name => {
    // @pullboard-board-file persistence: replay one sealed return into separate databases with different private heartbeat sidecars.
    const board = openBoard(join(box.dir, `return-${name}.sqlite`), clock);
    importBoard(board, document);
    t.after(() => store.closeBoard(board));
    return board;
  });
  heartbeatSeat(copies[0], store.getItem(copies[0], 1).item_built_by);
  assert.equal(store.listAgents(copies[0]).find(seat => seat.agent_id === store.getItem(copies[0], 1).item_built_by).presence, 'live');
  assert.equal(store.listAgents(copies[1]).find(seat => seat.agent_id === store.getItem(copies[1], 1).item_built_by).presence, 'gone');
  const order = { sequence: 1, at: now.toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } };
  const before = exportBoard(copies[0]);
  assert.throws(() => applyRelayMove(copies[0], { ...move, engine: REJECTED_WORK_RETURN_ENGINE - 1 }, order),
    error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(copies[0]), before, 'downgrade refuses before any board mutation');
  const results = copies.map(board => applyRelayMove(board, move, order));
  assert.equal(results[0].error, undefined, JSON.stringify(results[0]));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(exportBoard(copies[0]), exportBoard(copies[1]));
  for (const board of copies) {
    assert.equal(firstRefusal(board, 1), null);
    const after = exportBoard(board);
    assert.deepEqual(applyRelayMove(board, move, order), results[0]);
    assert.deepEqual(exportBoard(board), after, 'a replayed receipt appends nothing twice');
  }
});

