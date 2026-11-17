/** release.rerouteUntouched: untouched INELIGIBLE and ROUTED_ELSEWHERE releases count toward the release-twice reroute only when it is on [C7,#2970]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../fixtures/cell-board.js';

// fixture-subject: addItem (a store unit test of the release-twice reroute over a seat's untouched hand-backs; the board is opened through the cell fixture)

const commit = 'a'.repeat(40);
const SNAPSHOT = Object.freeze({ head: 'b'.repeat(40), digest: 'c'.repeat(64) });

/** A mid item whose one strong seat claimed it straight from next and handed it back untouched with `first`, then claimed it again the same way. */
function handedBack(t, { first, reroute }) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  if (reroute !== undefined) board.rerouteUntouched = reroute;
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const seat = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' });
  const claim = () => store.claim(board, id, { agentId: seat, lane: 'core', leaseMs: 7200000, head: SNAPSHOT.head, autoNext: true, autoNextSnapshot: SNAPSHOT,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  const release = reason => store.release(board, id, seat, '', { worktreeSnapshot: { ...SNAPSHOT } }, reason);
  claim(); release(first); claim();
  return { board, id, release };
}

const routeOf = f => store.getItem(f.board, f.id).item_route;

test('board.claim-reroute.with-release-rerouteuntouched-second-untouched-ineligible: clause 1: with release.rerouteUntouched on, a second untouched INELIGIBLE or ROUTED_ELSEWHERE release moves the item one route up [C7,#2970]', t => {
  for (const first of ['INELIGIBLE', 'ROUTED_ELSEWHERE']) {
    for (const second of ['INELIGIBLE', 'ROUTED_ELSEWHERE']) {
      const f = handedBack(t, { first, reroute: true });
      f.release(second);
      assert.equal(routeOf(f), 'strong', `${first} then ${second}`);
    }
  }
});

test('board.claim-reroute.with-release-rerouteuntouched-off-unset-untouched: clause 1: with release.rerouteUntouched off or unset, untouched releases leave the route unchanged [C7,#2970]', t => {
  for (const reroute of [false, undefined]) {
    const f = handedBack(t, { first: 'INELIGIBLE', reroute });
    f.release('INELIGIBLE');
    assert.equal(routeOf(f), 'mid', `reroute ${reroute}`);
  }
});
