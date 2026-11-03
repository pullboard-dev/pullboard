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

test('a Main red baseline with no case names, names without files, or from another main is re-taken before use [C7]', () => {
  const main = 'a'.repeat(40);
  const repairItem = (id, baseline) => ({ item_id: id, item_status: 'open', item_title: 'Main red: x case', item_check: CHECK, item_check_baseline: baseline });
  const evidence = { failed: ['x case [G1]'], passed: [], failedCases: [{ file: 'test/affected.test.js', name: 'x case [G1]' }], noTestsMatched: false };
  const unnamed = repairItem(1, { command: CHECK, main, result: 'red' });
  const stale = repairItem(2, { command: CHECK, main: 'b'.repeat(40), result: 'red', testEvidence: evidence });
  const named = repairItem(3, { command: CHECK, main, result: 'red', testEvidence: evidence });
  const nameOnly = repairItem(4, { command: CHECK, main, result: 'red', testEvidence: { failed: ['x case [G1]'], passed: [], noTestsMatched: false } });
  assert.deepEqual(mainRedBaselinesToRetake([unnamed, stale, named, nameOnly], ['test/affected.test.js'], 9, main).map(item => item.item_id), [1, 2, 4]);
  const failure = { file: 'test/affected.test.js', name: 'x case [G1]' };
  assert.deepEqual(mainRedItemCases([failure], [unnamed], 9, main).owned, [], 'an unnamed baseline owns nothing until re-taken');
  assert.deepEqual(mainRedItemCases([failure], [nameOnly], 9, main).owned, [], 'a baseline naming cases without files owns nothing until re-taken');
  const retaken = new Map([[1, { command: CHECK, main, result: 'red', testEvidence: { ...evidence, passed: ['y case [G1]'] } }]]);
  assert.deepEqual(mainRedItemCases([failure, { ...failure, name: 'y case [G1]' }], [unnamed], 9, main, retaken),
    { owned: [{ ...failure, item: 1 }], rest: [{ ...failure, name: 'y case [G1]' }] });
});

test('the same case name in another file is not known main: A/X red on main, B/X green, a candidate breaking B/X is refused [C7]', () => {
  const main = 'a'.repeat(40);
  const check = 'node test/runner.js test/a.test.js test/b.test.js';
  // The repair's check runs both files on main: X fails in A and passes in B.
  const repairItem = { item_id: 1, item_status: 'open', item_title: 'Main red: A/X', item_check: check, item_check_baseline: { command: check, main, result: 'red',
    testEvidence: { failed: ['X'], passed: ['X'], failedCases: [{ file: 'test/a.test.js', name: 'X' }], noTestsMatched: false } } };
  const broken = { file: 'test/b.test.js', name: 'X' };
  assert.deepEqual(mainRedItemCases([broken], [repairItem], 9, main), { owned: [], rest: [broken] }, 'B/X stays a new failure');
  const knownA = { file: 'test/a.test.js', name: 'X' };
  assert.deepEqual(mainRedItemCases([knownA, broken], [repairItem], 9, main), { owned: [{ ...knownA, item: 1 }], rest: [broken] },
    'with any case left over, the submit still refuses');
});
