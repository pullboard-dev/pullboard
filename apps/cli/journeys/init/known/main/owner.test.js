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
  const args = ['add', 'core', `Main red: ${criterion}`, '--specs', 'G1',
    '--criterion', criterion, '--check', 'node test/runner.js test/affected.test.js', '--brief', 'Files: test/affected.test.js\nTest: shared cases'];
  let result = cli(box, box.root, ...args);
  // The second repair reads like the first by design: answer the near-duplicate guard with the nearest id it names.
  const nearest = /DUPLICATE_LIKELY[\s\S]*?#(\d+)/u.exec(result.stdout + result.stderr)?.[1];
  if (result.status !== 0 && nearest) result = cli(box, box.root, ...args, '--not-duplicate-of', `${nearest} each repair owns a different case`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('two repairs naming the same file each own the case their criterion names [V4,B3]', { skip: 'CONTROLLER_ONLY: deleted with #6832' }, t => {
  const box = fixture(t, { affected: SHARED });
  const alpha = fileMainRed(box, "The case 'alpha case' passes on main.");
  const beta = fileMainRed(box, "The case 'beta case [G1]' passes on main.");
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const owners = Object.fromEntries(JSON.parse(result.stdout).gate.knownMainReworks.map(row => [row.name, row.item]));
  assert.deepEqual(owners, { 'alpha case [G1]': alpha, 'beta case [G1]': beta });
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

test('a case no single repair names is ambiguous but red on main, so submit accepts it and names the candidates [V4,B3,C7]', { skip: 'CONTROLLER_ONLY: deleted with #6832' }, t => {
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
