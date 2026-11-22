/** The existing settings provider distinguishes omitted and explicit homes [C7,#12944]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { machineHome } from '../../src/io/home.js';
import { machineSettingsFile } from '../../src/io/home.js';

/** Keep both temporary homes and the process override private to this case. */
function homes(t) {
  const first = privateFixtureFiles('pullboard-settings-first-').root;
  const second = privateFixtureFiles('pullboard-settings-second-').root;
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
  assert.notEqual(first, second);
  return { first, second };
}

test('resources.home.machine-settings-default: [C7] omitted home follows the current process override on every call', t => {
  const { first, second } = homes(t);
  process.env.PULLBOARD_MACHINE_HOME = first;
  assert.equal(machineHome(), first);
  assert.equal(machineSettingsFile(), join(first, 'settings.json'));
  process.env.PULLBOARD_MACHINE_HOME = second;
  assert.equal(machineHome(), second);
  assert.equal(machineSettingsFile(), join(second, 'settings.json'));
});

test('resources.home.machine-settings-explicit: [C7] a supplied home is independent and explicit invalid inputs retain native rejection', t => {
  const { first, second } = homes(t);
  process.env.PULLBOARD_MACHINE_HOME = first;
  assert.equal(machineSettingsFile(second), join(second, 'settings.json'));
  process.env.PULLBOARD_MACHINE_HOME = second;
  assert.equal(machineSettingsFile(first), join(first, 'settings.json'));
  for (const invalid of [undefined, null, 42, {}, []]) {
    assert.throws(() => machineSettingsFile(invalid), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  assert.equal(machineSettingsFile(), join(second, 'settings.json'));
});
