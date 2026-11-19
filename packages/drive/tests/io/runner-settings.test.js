/** runnerSettingNumber reads a bounded number from the machine settings file, else the fallback [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runnerSettingNumber } from '../../src/io/runner-settings.js';
import { temporaryDirectory } from '../../../board/tests/fixtures/board.js';

test('drive.runner-settings.number-setting: clause 3: runnerSettingNumber returns a finite number from 1 to 4 in the settings file, else the fallback [C7]', t => {
  const folder = temporaryDirectory('pullboard-runner-number-');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const read = document => { writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document)); return runnerSettingNumber(file, 'runners.jobWorkerFactor', 2); };
  assert.equal(read({ 'runners.jobWorkerFactor': 3 }), 3);
  assert.equal(read({ 'runners.jobWorkerFactor': 1 }), 1, 'the lower bound is allowed');
  assert.equal(read({ 'runners.jobWorkerFactor': 4 }), 4, 'the upper bound is allowed');
  assert.equal(read({ 'runners.jobWorkerFactor': 1.5 }), 1.5);
  for (const value of [0, 0.5, 4.5, 9, -1, '3', null, true, [3]]) assert.equal(read({ 'runners.jobWorkerFactor': value }), 2, `${JSON.stringify(value)} gives the fallback`);
  assert.equal(read({}), 2, 'a missing key gives the fallback');
  assert.equal(read('not json'), 2, 'unreadable content gives the fallback');
  assert.equal(runnerSettingNumber(join(folder, 'absent.json'), 'runners.jobWorkerFactor', 2), 2, 'a missing file gives the fallback');
});
