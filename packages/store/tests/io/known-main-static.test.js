/** A static run's known main findings are recorded on the item as known main red facts [C7,#10451]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../index.js';
import { recordKnownMainStatic } from '../../index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';

const MAIN = 'a'.repeat(40);

// fixture-subject: addItem (a store unit test of the known main facts recorded on one seeded item)
test('clause 1: recording the knownMain findings writes one known main red fact per rule and file on the item, and nothing for an empty list [C7,#10451]', t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/known-static/main' });
  const agentId = store.register(board, { lane: 'core', path: '/known-static/seat', route: 'strong', family: 'anthropic' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Static item', route: 'mid', criterion: 'it works [test]', check: 'true', brief: 'Files: web/a.js\nTest: the case' });
  assert.deepEqual(recordKnownMainStatic(board, id, { agentId, findings: [], main: MAIN }), []);
  const findings = [
    { rule: 'runs a git fetch outside the one entry point', file: 'packages/a/x.js' },
    { rule: 'runs a git fetch outside the one entry point', file: 'packages/b/y.js' },
  ];
  const written = recordKnownMainStatic(board, id, { agentId, findings, main: MAIN });
  assert.equal(written.length, 2);
  const texts = store.itemThread(board, id).filter(entry => entry.type === 'fact' && entry.kind === 'measurement').map(entry => entry.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /^Red again: packages\/a\/x\.js :: runs a git fetch outside the one entry point\. static finding, also red on main aaaaaaaaaaaa/u);
  assert.match(texts[1], /packages\/b\/y\.js/u);
});
