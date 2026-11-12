/** Real affected-case known-main submission controls [V4,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { fileMainRed } from '../../../../tests/fixtures/affected.js';

test('an affected case red identically on main with no owner submits, names it, records a fact and shouts [V4,B3]', t => {
  const box = fixture(t);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.green, false, 'the known red stays visible in the receipt');
  assert.deepEqual(report.gate.knownMainUnowned, [{ file: 'test/affected.test.js', name: 'affected case [G1]' }], 'the receipt names the known main red');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'submit files no item');
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('unowned known main red: the submission proof')
    && entry.text.includes('test/affected.test.js') && entry.text.includes('affected case [G1]')), 'the item names the unowned file and case');
  const asked = rows(box, 'SELECT * FROM shout').filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1 && String(row.shout_text).includes('test/affected.test.js'));
  assert.equal(asked.length, 1, 'exactly one decision shout reaches the coordinator');
});

test('an open Main red repair naming the affected file is linked [V4,B3]', t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.gate.knownMainReworks.map(row => [row.file, row.item]), [['test/affected.test.js', repair]]);
  assert.equal(report.gate.knownMainUnowned, undefined);
});

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
