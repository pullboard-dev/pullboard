/** A Main red item whose named test already passes on current main is closed with the recorded run, never offered [C7,H24]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passingMainReds } from '../../../../../packages/landing/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../../tests/fixtures/next/take.js';
import { cacheFile } from '../../../../../packages/landing/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const main = 'a'.repeat(40);
const file = 'test/x.test.js';
const item = (id, extra = {}) => ({ item_id: id, item_status: 'open', item_title: `Main red: ${file}`, ...extra });

test('clause 1: an open Main red item whose file is green on current main is closed with the recorded run [C7,H24]', () => {
  const found = passingMainReds([item(1)], main, { [main]: { [file]: { result: 'green', receiptId: 'run-1' } } });
  assert.deepEqual(found, [{ item: 1, file, receiptId: 'run-1', main, turnedGreen: main }]);
});

test('clause 2: an item whose named case still fails on current main is offered as today [C7,H24]', () => {
  const entries = { [main]: { [file]: { result: 'red', receiptId: 'run-2', failures: [{ name: 'x case' }] } } };
  const named = { item_check_baseline: { testEvidence: { failedCases: [{ file, name: 'x case' }] } } };
  assert.deepEqual(passingMainReds([item(1, named), item(2)], main, entries), []);
  const fixed = { [main]: { [file]: { result: 'red', failures: [{ name: 'other case' }] } } };
  // Stale since the item closes only on a green file: a red file stays open on different cases (#3382).
  assert.deepEqual(passingMainReds([item(1, named)], main, fixed), []);
});

test('clause 3: the check reads only recorded runs for the current main and adds none of its own [C7,H24]', () => {
  assert.deepEqual(passingMainReds([item(1)], main, { ['b'.repeat(40)]: { [file]: { result: 'green' } } }), []);
  assert.deepEqual(passingMainReds([item(1)], main, { [main]: {} }), []);
  assert.deepEqual(passingMainReds([item(1, { item_status: 'claimed' })], main, { [main]: { [file]: { result: 'green' } } }), []);
});

test('clause 1: next withdraws an open Main red item whose file is green on the recorded main run and does not offer it [C7,H24]', async t => {
  const box = await fixture(t, { route: 'mid' });
  const closed = box.add(`Main red: ${file}`, { route: 'mid' });
  const kept = box.add('Ordinary current work', { route: 'mid' });
  const head = mainCheckout(box.root).commit;
  const cache = cacheFile(box.root);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ version: 2, entries: { [head]: { [file]: { result: 'green', receiptId: 'run-recorded-1' } } } }), { mode: 0o600 });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(getItem(box.board, closed).item_status, 'withdrawn', 'the passing Main red item is closed');
  assert.notEqual(taken.document.item?.item_id, closed, 'next never offers the closed item');
  assert.equal(taken.document.item.item_id, kept);
  const events = box.board.db.prepare("SELECT * FROM event WHERE event_kind = 'withdraw'").all();
  assert.match(JSON.stringify(events), /run-recorded-1/u, 'the recorded run is cited as proof');
});
