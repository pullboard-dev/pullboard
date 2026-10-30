/** Several open repairs naming one test file each own the case their criterion names; an unnamed case is ambiguous [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './known-main-affected.fixture.js';
import { cli } from './known-main-affected.fixture.js';
import { rows } from './known-main-affected.fixture.js';

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

test('a case no single repair names is ambiguous: the submit refuses and lists both candidates [V4,B3]', t => {
  const box = fixture(t, { affected: SHARED });
  const alpha = fileMainRed(box, "The case 'alpha case' passes on main.");
  const other = fileMainRed(box, 'The shared file passes on main.');
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, 'GATE_RED');
  assert.ok(error.message.includes(`several candidate owners, none naming the case alone: test/affected.test.js (beta case [G1]): #${alpha}, #${other}`), error.message);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
