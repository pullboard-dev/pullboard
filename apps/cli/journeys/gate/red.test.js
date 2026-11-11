/** A case already red on main never fails the item's gate; a newly red case still does [C7,V4,B3]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cli,
  fixture,
  rows,
} from '../../tests/fixtures/affected.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

/** Two cases red on main; the item changes neither. */
const SHARED = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('alpha case [G1]', () => assert.equal(1, 2));\ntest('beta case [G1]', () => assert.equal(1, 3));\n";
const CHECK = 'node test/runner.js test/affected.test.js';

/** File an open repair for the shared file whose criterion names one case, or none. */
function repair(box, criterion) {
  const result = cli(box, box.root, 'add', 'core', `Main red: ${criterion}`, '--specs', 'G1', '--criterion', criterion,
    '--check', CHECK, '--brief', 'Files: test/affected.test.js\nTest: shared cases');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('a check case red on main with two candidate repairs is reported as known-main and the gate passes [C7,V4,B3]', t => {
  const box = fixture(t, { affected: SHARED, check: CHECK });
  const alpha = repair(box, "The case 'alpha case' passes on main.");
  const shared = repair(box, 'The shared file passes on main.');
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gate = JSON.parse(result.stdout).gate;
  assert.deepEqual(gate.knownMainAmbiguous, [{ file: 'test/affected.test.js', name: 'beta case [G1]', candidates: [alpha, shared] }]);
  assert.deepEqual(gate.knownMainReworks.map(row => [row.name, row.item]), [['alpha case [G1]', alpha]], 'the uniquely owned case keeps its repair link');
  assert.match(gate.report, /known main failure\(s\)/u);
  assert.match(gate.report, /beta case \[G1\]/u);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

test('a case newly red on the item still fails the gate even beside known-main reds [C7,V4,B3]', t => {
  const box = fixture(t, { affected: SHARED, check: CHECK });
  repair(box, "The case 'alpha case' passes on main.");
  repair(box, 'The shared file passes on main.');
  appendFileSync(join(box.builder, 'test/affected.test.js'), "test('gamma case [G1]', () => assert.equal(1, 4));\n");
  runFixtureGit(['commit', '-qam', 'test(core): a new red case [G1]'], { cwd: box.builder, env: box.env });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
