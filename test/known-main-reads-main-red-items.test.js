/** A case an open Main red item's own check fails on current main never fails another item's check [C7,V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli, fixture, rows } from './known-main-affected.fixture.js';
import { mainRedBaselinesToRetake, mainRedItemCases } from '../packages/store/index.js';

const CHECK = 'node test/runner.js test/affected.test.js';
// Case X fails on main and on the item, with a different message on each, so no exact comparison can match it; Y passes.
const SHARED = "import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { test } from 'node:test';\n"
  + "test('x case [G1]', () => assert.equal(existsSync('change.txt') ? 'item' : 'main', 'fixed'));\n"
  + "test('y case [G1]', () => assert.equal(1, 1));\n";

/** File the open Main red repair whose own check runs the shared file. */
function repair(box) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: x case', '--specs', 'G1', '--criterion', "The case 'x case' passes on main.",
    '--check', CHECK, '--brief', 'Files: test/affected.test.js\nTest: x case');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('an item whose check fails only a case an open Main red item fails on main is not refused [C7,V4,B3]', t => {
  const box = fixture(t, { affected: SHARED, check: CHECK });
  const owner = repair(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const facts = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='fact'", box.item).map(row => row.event_detail).join('\n');
  assert.match(facts, new RegExp(`test/affected\\.test\\.js \\(x case \\[G1\\]\\), repair #${owner}`, 'u'));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

test('control: with no open Main red item failing that case, the same red check is refused [C7,V4,B3]', t => {
  const box = fixture(t, { affected: SHARED, check: CHECK });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a Main red baseline with no case names, or from another main, is re-taken before the lookup uses it [C7]', () => {
  const main = 'a'.repeat(40);
  const repairItem = (id, baseline) => ({ item_id: id, item_status: 'open', item_title: 'Main red: x case', item_check: CHECK, item_check_baseline: baseline });
  const unnamed = repairItem(1, { command: CHECK, main, result: 'red' });
  const stale = repairItem(2, { command: CHECK, main: 'b'.repeat(40), result: 'red', testEvidence: { failed: ['x case [G1]'], passed: [], noTestsMatched: false } });
  const named = repairItem(3, { command: CHECK, main, result: 'red', testEvidence: { failed: ['x case [G1]'], passed: [], noTestsMatched: false } });
  assert.deepEqual(mainRedBaselinesToRetake([unnamed, stale, named], ['test/affected.test.js'], 9, main).map(item => item.item_id), [1, 2]);
  const failure = { file: 'test/affected.test.js', name: 'x case [G1]' };
  assert.deepEqual(mainRedItemCases([failure], [unnamed], 9, main).owned, [], 'an unnamed baseline owns nothing until re-taken');
  const retaken = new Map([[1, { command: CHECK, main, result: 'red', testEvidence: { failed: ['x case [G1]'], passed: ['y case [G1]'], noTestsMatched: false } }]]);
  assert.deepEqual(mainRedItemCases([failure, { ...failure, name: 'y case [G1]' }], [unnamed], 9, main, retaken),
    { owned: [{ ...failure, item: 1 }], rest: [{ ...failure, name: 'y case [G1]' }] });
});
