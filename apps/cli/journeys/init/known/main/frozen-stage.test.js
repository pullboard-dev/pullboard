/** A frozen check with a failing stage no case explains, or a case green at the actual merge base, refuses at the pulled gate [V4,B3]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../../../tests/fixtures/child.js';
import {
  commit,
  fileMainRed,
  fixture,
  FROZEN,
  put,
  rows,
  settledSubmit,
  source,
} from '../../../../tests/fixtures/init/known-frozen.js';

test('a frozen check with a failing stage no case explains refuses even when its cases are known [V4,B3]', async t => {
  const box = fixture(t, { check: FROZEN + '; exit 7' });
  fileMainRed(box);
  const report = await settledSubmit(t, box);
  assert.equal(report.gate.green, false, 'the pulled gate ends red: ' + JSON.stringify(report.gate));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a later main red never excuses a case green at the actual item merge base [V4,B3]', async t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const before = runFixtureChild(process.execPath, ['--test', join(box.root, 'test/frozen.test.js')],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(before.status, 0, before.stdout + before.stderr);
  put(box.root, 'test/frozen.test.js', source(2));
  const advancedMain = commit(box, box.root);
  const actualBase = runFixtureGit(['merge-base', box.head, advancedMain], { cwd: box.root, env: box.env }).trim();
  assert.equal(actualBase, box.main, 'independent trunk movement preserves the original green merge base');
  const current = runFixtureChild(process.execPath, ['--test', join(box.root, 'test/frozen.test.js')],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(current.status, 1, 'the independent current-main failure is real');
  const report = await settledSubmit(t, box);
  assert.equal(report.gate.green, false, 'the pulled gate ends red: ' + JSON.stringify(report.gate));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
