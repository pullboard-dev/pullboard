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
