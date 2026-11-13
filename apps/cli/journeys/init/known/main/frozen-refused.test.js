/** A frozen case that is new on the item or fails differently than on main refuses at the pulled gate [V4,B3]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  rows,
  settledSubmit,
} from '../../../../tests/fixtures/init/known-frozen.js';

test('a frozen case green on main but red on the item still refuses [V4,B3]', async t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const report = await settledSubmit(t, box);
  assert.equal(report.gate.green, false, 'the pulled gate ends red: ' + JSON.stringify(report.gate));
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'a new failure files no main red');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a frozen case that fails differently on the item than on main refuses [V4,B3]', async t => {
  const box = fixture(t, { main: 2, candidate: 3 });
  const report = await settledSubmit(t, box);
  assert.equal(report.gate.green, false, 'the pulled gate ends red: ' + JSON.stringify(report.gate));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
