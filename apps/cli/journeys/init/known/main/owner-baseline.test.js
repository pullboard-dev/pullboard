/** An open repair's baseline excuses an identical red case on main, never one the item changes [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';

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

// Case X fails on main and on the item with the same assertion, so the repair's baseline excuses it.
const SAME_SHARED = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('x case [G1]', () => assert.equal('main', 'fixed'));\ntest('y case [G1]', () => assert.equal(1, 1));\n";

test('an item whose check fails only a case an open Main red item fails the same way on main is not refused [C7,V4,B3]', t => {
  const box = fixture(t, { affected: SAME_SHARED, check: READS_CHECK });
  const owner = fileReadsRepair(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const facts = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='fact'", box.item).map(row => row.event_detail).join('\n');
  assert.match(facts, new RegExp(`test/affected\\.test\\.js \\(x case \\[G1\\]\\), open repair #${owner}`, 'u'));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

test('a repair baseline never excuses a case the item fails with a changed assertion (#4531) [C7,V4,B3]', t => {
  const box = fixture(t, { affected: READS_SHARED, check: READS_CHECK });
  fileReadsRepair(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('control: with no open Main red item failing that case, the same red check is refused [C7,V4,B3]', t => {
  const box = fixture(t, { affected: READS_SHARED, check: READS_CHECK });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
