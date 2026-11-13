/** Real affected-case known-main refusals: a red only on the item still refuses [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';

test('an affected case red only on the item still refuses [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('an affected case that fails differently on the item than on main refuses [V4,B3]', t => {
  const box = fixture(t, { main: 2, candidate: 3, criterion: 'test/affected.test.js retains its behavior.' });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a recorded main red is reused while a new head failure still refuses [V4,B3]', t => {
  const affected = `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
test('inherited failure [G1]', () => assert.equal(1, 2));
test('new head failure [G1]', () => assert.equal(existsSync('change.txt'), false));
`;
  const box = fixture(t, { affected });
  const mainRuns = () => rows(box, "SELECT event_detail FROM event WHERE event_kind='gate-run'")
    .map(row => JSON.parse(row.event_detail).run).filter(run => run.kind === 'main-red' && run.head === box.main);
  const first = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.equal(JSON.parse(first.stdout).error.code, 'GATE_RED');
  assert.match(first.stdout + first.stderr, /new head failure/u);
  const observed = mainRuns();
  assert.ok(observed.length > 0, 'the real first comparison is recorded on the board');
  const second = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(second.status, 1, second.stdout + second.stderr);
  assert.equal(JSON.parse(second.stdout).error.code, 'GATE_RED');
  assert.match(second.stdout + second.stderr, /new head failure/u);
  assert.equal(mainRuns().length, observed.length, 'the recorded exact-main result avoids another main run');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
