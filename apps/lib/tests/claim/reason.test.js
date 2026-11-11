/** Native releases and their daily work-free report retain the recorded reasons [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openBoard } from '../../index.js';
import { addItem } from '../../../../packages/store/index.js';
import { claim } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { register } from '../../../../packages/store/index.js';
import { release } from '../../../../packages/store/index.js';
import { releaseReasonProblem } from '../../../../packages/store/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { workFreeReleases } from '../../../../packages/stats/index.js';
import { counterProofStats } from '../../../../packages/verify/index.js';
import { TAKEN_OVER_RELEASE_ENGINE } from '../../../../packages/state/light.js';
import { release as releaseMove } from '../../../../packages/moves/index.js';

test('each release reason is recorded and health and stats count work-free claims per day and seat [C7]', t => {
  const now = new Date('2026-11-02T12:00:00.000Z');
  const board = openBoard(':memory:', { now: () => now });
  t.after(() => closeBoard(board));
  register(board, { lane: 'coordinator', path: '/actors/coordinator' });
  register(board, { lane: 'web', path: '/actors/builder', family: 'test' });
  const reasons = ['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'OTHER'];
  assert.equal(releaseReasonProblem('TAKEN_OVER', '', TAKEN_OVER_RELEASE_ENGINE - 1).code, 'ENGINE_VERSION');
  assert.ok(releaseMove.minimumEngine([1, 'web-1', '', {}, 'TAKEN_OVER']) >= TAKEN_OVER_RELEASE_ENGINE);
  assert.ok(releaseMove.minimumEngine([1, 'web-1', '', 'TAKEN_OVER']) >= TAKEN_OVER_RELEASE_ENGINE);
  for (const reason of reasons) {
    const id = addItem(board, { by: 'coordinator', lane: 'web', title: `Release ${reason}`, criterion: 'A recorded reason' });
    claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3600000, freeze: () => ({ text: 'A recorded reason', digest: 'digest' }) });
    release(board, id, 'web-1', reason === 'OTHER' ? 'A specific explanation' : '', reason);
  }
  const history = events(board);
  assert.deepEqual(history.filter(event => event.event_kind === 'release').map(event => JSON.parse(event.event_detail).reasonCode), reasons);
  const expected = reasons.map(reason => ({ day: '2026-11-02', seat: 'web-1', reason, count: 1 })).sort((a, b) => a.reason.localeCompare(b.reason));
  const stats = proofStats(board, { now: now.getTime() }, { events, counterProofStats });
  assert.deepEqual(stats.workFreeReleases, expected);
  const health = healthReport({ db: board.db, root: process.cwd(), config: {}, now, dispatchHealth: () => ({ findings: [] }) });
  assert.deepEqual(health.workFreeReleases, expected);
  assert.deepEqual(events(board), history, 'both reports leave the board unchanged');
});

test('renewals retain a claim, while work and review releases never count as work-free [C7]', () => {
  const at = '2026-11-02T12:00:00.000Z';
  const event = (item_id, event_kind, event_by, detail = {}) => ({ item_id, event_kind, event_by, event_at: at, event_detail: JSON.stringify(detail) });
  const history = [event(1, 'claim', 'web-1'), event(1, 'claim', 'web-1'), event(1, 'submit', 'web-1'), event(1, 'release', 'web-1', { reasonCode: 'OTHER' }),
    event(2, 'claim', 'web-2'), event(2, 'release', 'reviewer', { review: true }), event(2, 'release', 'coordinator', { reasonCode: 'BLOCKED' }),
    event(3, 'release', 'web-3', { reasonCode: 'BUDGET' })];
  assert.deepEqual(workFreeReleases(history), [{ day: '2026-11-02', seat: 'web-2', reason: 'BLOCKED', count: 1 }]);
  assert.deepEqual(workFreeReleases(history, { since: '2026-11-02T12:00:01.000Z' }), []);
  assert.deepEqual(workFreeReleases([event(4, 'claim', 'web-1'), event(4, 'submit', 'web-1'), event(4, 'lapse', 'clock'),
    event(4, 'claim', 'web-1'), event(4, 'release', 'web-1', { reasonCode: 'BUDGET' })]),
  [{ day: '2026-11-02', seat: 'web-1', reason: 'BUDGET', count: 1 }]);
});
