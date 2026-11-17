/** A brief already in Files, Change and Test form is its own diagnosis for a light seat (#3193) [C7]. */
// fixture-subject: addItem (a store unit test of claim over items it files; the board is the store package fixture)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../index.js';
import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../state/index.js';
import { fixtureBoard } from '../../board/tests/fixtures/board.js';

const GOOD = 'Files: web/handler.js test/handler.test.js\nChange: repoint the handler\nTest: the handler case returns the result';
const BAD = 'Files: web/handler.js\nTest: the handler case';

/** A native board with one light seat, and helpers to file and claim items. */
function fixture(t) {
  const board = fixtureBoard(t);
  board.executionEngineVersion = TWO_TIER_DIAGNOSIS_ENGINE;
  store.register(board, { lane: 'coordinator', path: '/lbd/main' });
  const light = store.register(board, { lane: 'core', path: '/lbd/light', route: 'light', family: 'anthropic' });
  const add = (brief, route = 'mid') => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Light correction', route,
    criterion: 'the correction works [test]', check: 'true', brief });
  const claim = id => store.claim(board, id, { agentId: light, lane: 'core', leaseMs: 3_600_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'lbd-bar' }) });
  return { board, light, add, claim };
}

test('store.light-brief-diagnosis.store-claim-by-a-light-seat: clause 1: store.claim by a light seat succeeds on a light item whose brief parses and has no diagnosis fact [C7]', t => {
  const f = fixture(t);
  const id = f.add(GOOD, 'light');
  assert.doesNotThrow(() => f.claim(id));
  assert.equal(store.getItem(f.board, id).item_owner, f.light);
});

test('store.light-brief-diagnosis.store-claim-by-a-light-seat-2: clause 2: store.claim by a light seat on a light item whose brief does not parse refuses DIAGNOSIS_REQUIRED [C7]', t => {
  const f = fixture(t);
  assert.throws(() => f.add(BAD, 'light'), { code: 'DIAGNOSIS_REQUIRED' });
  const id = f.add(BAD);
  assert.throws(() => store.editItem(f.board, id, { agentId: 'coordinator', route: 'light' }), { code: 'DIAGNOSIS_REQUIRED' });
  // A light item filed before the rule existed, with a brief that is not in diagnosis form.
  f.board.db.prepare("UPDATE item SET item_route = 'light' WHERE item_id = ?").run(id);
  assert.throws(() => f.claim(id), { code: 'DIAGNOSIS_REQUIRED' });
});
