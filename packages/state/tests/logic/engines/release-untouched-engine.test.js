/** @pullboard-test-input source-cell packages/state packages/store */
/** The untouched-release reroute has its own engine number: older boards keep today's release decisions, newer ones count untouched hand-backs [C7,#2970]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../../store/tests/fixtures/cell.js';
import { ENGINE_VERSION } from '../../../light.js';
import { RELEASE_TWICE_ROUTE_ENGINE } from '../../../light.js';
import { RELEASE_UNTOUCHED_REROUTE_ENGINE as LIGHT_ENGINE } from '../../../light.js';
import { RELEASE_UNTOUCHED_REROUTE_ENGINE } from '../../../src/logic/engines/release-untouched-engine.js';

// fixture-subject: addItem (a state test of the untouched reroute engine over a seat's hand-backs; the board is opened through the cell fixture)

const commit = 'a'.repeat(40);
const SNAPSHOT = Object.freeze({ head: 'b'.repeat(40), digest: 'c'.repeat(64) });

/** A mid item a strong seat claimed from next and handed back untouched twice, on a board replayed at `engine` with the reroute setting on. */
function handedBackTwice(t, engine) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  board.rerouteUntouched = true;
  board.executionEngineVersion = engine;
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const seat = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' });
  const claim = () => store.claim(board, id, { agentId: seat, lane: 'core', leaseMs: 7200000, head: SNAPSHOT.head, autoNext: true, autoNextSnapshot: SNAPSHOT,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  const release = reason => store.release(board, id, seat, '', { worktreeSnapshot: { ...SNAPSHOT } }, reason);
  claim(); release('INELIGIBLE'); claim(); release('ROUTED_ELSEWHERE');
  return store.getItem(board, id).item_route;
}

test('clause 1: the registry has an engine number for the untouched-release reroute, above the release-twice route engine [C7,#2970]', () => {
  assert.ok(Number.isInteger(RELEASE_UNTOUCHED_REROUTE_ENGINE) && RELEASE_UNTOUCHED_REROUTE_ENGINE > RELEASE_TWICE_ROUTE_ENGINE);
  assert.equal(LIGHT_ENGINE, RELEASE_UNTOUCHED_REROUTE_ENGINE, 'the state door forwards the leaf');
  assert.ok(ENGINE_VERSION >= RELEASE_UNTOUCHED_REROUTE_ENGINE, 'the registry version covers the new engine');
});

test('clause 1: a board replayed below that engine keeps today\'s release decisions: untouched releases do not count [C7,#2970]', t => {
  assert.equal(handedBackTwice(t, RELEASE_UNTOUCHED_REROUTE_ENGINE - 1), 'mid');
});

test('clause 1: a board replayed at or above that engine counts untouched INELIGIBLE and ROUTED_ELSEWHERE releases and moves the item one route up [C7,#2970]', t => {
  assert.equal(handedBackTwice(t, RELEASE_UNTOUCHED_REROUTE_ENGINE), 'strong');
  assert.equal(handedBackTwice(t, RELEASE_UNTOUCHED_REROUTE_ENGINE + 1), 'strong');
});
