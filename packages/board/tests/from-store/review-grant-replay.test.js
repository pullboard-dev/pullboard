/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/agent-grant.js */
/** A cross-lane verdict is review from its engine on, and older verdicts replay as they were recorded [E21,V2,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../fixtures/cell-board.js';
import {
  exportBoard,
  importBoard,
} from '../../../store/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../state/index.js';
import { REVIEW_GRANT_ENGINE } from '../../../state/index.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';

const BASE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const AT = '2026-10-26T08:00:00.000Z';

/** Build a submitted web item whose builder holds a current-engine grant, with an api reviewer seat. */
function submitted(t) {
  const board = openBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/fixture' });
  store.register(board, { lane: 'web', path: '/fixture/web-1' });
  store.register(board, { lane: 'api', path: '/fixture/api-1' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Cross-lane review fixture' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: BASE,
    freeze: () => ({ text: JSON.stringify({ rows: [], policy: { version: 1, commit: BASE, verify: { policy: 'any', family: 'off' } } }), digest: DIGEST }) });
  submitFixture(board, id, { agentId: 'web-1', commit: COMMIT, tree: TREE, files: ['web/feature.js'], policyCommit: BASE });
  return { board, id };
}

/** Open an independent replica of the seed through the public exchange format. */
function replica(t, seed) {
  const board = openBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => store.closeBoard(board));
  importBoard(board, exportBoard(seed));
  return board;
}

/** An api-lane reviewer's acceptance that holds no review reservation, recorded at a given engine. */
function verdictAt(seed, id, engine) {
  const verdict = { agentId: 'api-1', decision: 'ACCEPT', note: 'Reviewed from another lane without a reservation.',
    head: COMMIT, digest: DIGEST, policy: 'any', familyPolicy: 'off', check: 'green' };
  return { ...prepareEngineMove(seed, 'verify', [id, verdict], { id: `cross-lane-verdict-${engine}` }), engine };
}

test('board.review-grant-replay.unreserved-cross-lane-verdict-review-from: an unreserved cross-lane verdict is review from its engine on, and older ones replay refused [E21,V2,H16]', (t) => {
  const { board: seed, id } = submitted(t);
  const order = { sequence: 1, at: AT };

  const older = verdictAt(seed, id, REVIEW_GRANT_ENGINE - 1);
  const historical = [replica(t, seed), replica(t, seed)].map(board => applyEngineMove(board, older, order));
  assert.equal(historical[0].error?.code, 'AGENT_GRANT_LANE', 'a verdict recorded before this engine keeps its recorded refusal');
  assert.deepEqual(historical[1], historical[0], 'every fresh replica replays the older verdict identically');

  const current = verdictAt(seed, id, REVIEW_GRANT_ENGINE);
  const replicas = [replica(t, seed), replica(t, seed)];
  const outcomes = replicas.map(board => applyEngineMove(board, current, order));
  assert.equal(outcomes[0].error, undefined, 'from this engine on, a cross-lane verdict is review: ' + JSON.stringify(outcomes[0].error));
  assert.deepEqual(outcomes[1], outcomes[0]);
  for (const board of replicas) assert.equal(store.getItem(board, id).item_status, 'verified');
});
