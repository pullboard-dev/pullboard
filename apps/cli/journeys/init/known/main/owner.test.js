/** Several open repairs naming one test file each own the case their criterion names; an unnamed case is ambiguous [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';

/** Two real cases red on main and unchanged by the item, so each needs its own owner. */
const SHARED = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('alpha case [G1]', () => assert.equal(1, 2));\ntest('beta case [G1]', () => assert.equal(1, 3));\n";

/** File an open repair whose check names the shared file and whose criterion names one case (or none). */
function fileMainRed(box, criterion) {
  const result = cli(box, box.root, 'add', 'core', `Main red: ${criterion}`, '--specs', 'G1',
    '--criterion', criterion, '--check', 'node test/runner.js test/affected.test.js', '--brief', 'Files: test/affected.test.js\nTest: shared cases');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('two repairs naming the same file each own the case their criterion names [V4,B3]', t => {
  const box = fixture(t, { affected: SHARED });
  const alpha = fileMainRed(box, "The case 'alpha case' passes on main.");
  const beta = fileMainRed(box, "The case 'beta case [G1]' passes on main.");
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const owners = Object.fromEntries(JSON.parse(result.stdout).gate.knownMainReworks.map(row => [row.name, row.item]));
  assert.deepEqual(owners, { 'alpha case [G1]': alpha, 'beta case [G1]': beta });
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

test('a case no single repair names is ambiguous but red on main, so submit accepts it and names the candidates [V4,B3,C7]', t => {
  const box = fixture(t, { affected: SHARED });
  const alpha = fileMainRed(box, "The case 'alpha case' passes on main.");
  const other = fileMainRed(box, 'The shared file passes on main.');
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gate = JSON.parse(result.stdout).gate;
  assert.deepEqual(gate.knownMainAmbiguous, [{ file: 'test/affected.test.js', name: 'beta case [G1]', candidates: [alpha, other] }]);
  assert.deepEqual(gate.knownMainReworks.map(row => [row.name, row.item]), [['alpha case [G1]', alpha]]);
  assert.match(gate.report, /several candidate owners/u);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

const READS_CHECK = 'node test/runner.js test/affected.test.js';
// Case X fails on main and on the item, with a different message on each, so no exact comparison can match it; Y passes.
const READS_SHARED = "import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { test } from 'node:test';\n"
  + "test('x case [G1]', () => assert.equal(existsSync('change.txt') ? 'item' : 'main', 'fixed'));\n"
  + "test('y case [G1]', () => assert.equal(1, 1));\n";

/** File the open Main red repair whose own check runs the shared file. */
function fileReadsRepair(box) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: x case', '--specs', 'G1', '--criterion', "The case 'x case' passes on main.",
    '--check', READS_CHECK, '--brief', 'Files: test/affected.test.js\nTest: x case');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('an item whose check fails only a case an open Main red item fails on main is not refused [C7,V4,B3]', t => {
  const box = fixture(t, { affected: READS_SHARED, check: READS_CHECK });
  const owner = fileReadsRepair(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const facts = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='fact'", box.item).map(row => row.event_detail).join('\n');
  assert.match(facts, new RegExp(`test/affected\\.test\\.js \\(x case \\[G1\\]\\), repair #${owner}`, 'u'));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

test('control: with no open Main red item failing that case, the same red check is refused [C7,V4,B3]', t => {
  const box = fixture(t, { affected: READS_SHARED, check: READS_CHECK });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
