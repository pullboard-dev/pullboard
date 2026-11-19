/** next.returnedFirst is a machine setting, off by default, listed with a description and read through nextReturnedFirst [C7,#2220]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeSetting } from '../../../index.js';
import { nextReturnedFirst } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-returned-first-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-next-returned-first.reads-false-when-unset: clause 1: next.returnedFirst reads false when unset, true only when set true, and a non-boolean is refused BAD_MACHINE_SETTINGS [C7,#11241]', () => {
  assert.equal(withSettings({}, nextReturnedFirst), false);
  assert.equal(withSettings({ next: { returnedFirst: false } }, nextReturnedFirst), false);
  assert.equal(withSettings({ next: { returnedFirst: true } }, nextReturnedFirst), true);
  assert.throws(() => withSettings({ next: { returnedFirst: 'yes' } }, nextReturnedFirst), error => error.code === 'BAD_MACHINE_SETTINGS' && /next\.returnedFirst/u.test(error.message));
});

test('config.io-settings-next-returned-first.described-and-follows-the-setting: clause 2: describeSetting for next.returnedFirst names returned work, and nextReturnedFirst follows the setting [C7,#11241]', () => {
  const described = describeSetting('next.returnedFirst');
  assert.match(JSON.stringify(described), /returned work/u);
  assert.equal(withSettings({ next: { returnedFirst: true } }, nextReturnedFirst), true);
  assert.equal(withSettings({}, nextReturnedFirst), false);
});
