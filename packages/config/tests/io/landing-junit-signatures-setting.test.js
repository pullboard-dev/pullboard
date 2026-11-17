/** landing.junitSignatures is accepted from a real machine settings.json, off by default [C7,#9768]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** The inventory row for landing.junitSignatures read from a private machine home holding the given settings.json. */
function row(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-junit-signatures-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.junitSignatures');
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: landing.junitSignatures set through a real settings.json is read, not refused BAD_MACHINE_SETTINGS [C7,#9768]', () => {
  assert.equal(row({}).value, false);
  assert.equal(row({ landing: { junitSignatures: true } }).value, true);
  assert.equal(row({ landing: { junitSignatures: false } }).value, false);
  assert.throws(() => row({ landing: { junitSignatures: 'yes' } }), error => error.code === 'BAD_MACHINE_SETTINGS' && /landing\.junitSignatures/u.test(error.message));
});
