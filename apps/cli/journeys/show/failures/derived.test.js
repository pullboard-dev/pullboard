/** A derived main-red repair filed by a pulled gate keeps the first error line, and show prints it [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../tests/fixtures/affected.js';
import { rows } from '../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../tests/fixtures/affected.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

test('a derived main-red repair keeps the actual first error line and show prints it [C7,V4]', async t => {
  const box = fixture(t, { autoFileMainReds: true });
  await settledSubmit(t, box);
  const repairs = rows(box, "SELECT * FROM item WHERE item_title LIKE 'Main red:%'");
  assert.equal(repairs.length, 1);
  const shown = runFixtureChild('pullboard', ['show', String(repairs[0].item_id)], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /main red: affected case \[G1\]:/u);
  assert.match(shown.stdout, /Expected values to be strictly equal/u);
});

