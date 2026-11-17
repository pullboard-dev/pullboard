/** gate.staticLoadAdmission is off by default and only an exact true turns it on [C7,#8735]. @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_DEFAULTS } from '../../../src/io/settings/machine-defaults.js';
import { SETTING_DESCRIPTIONS } from '../../../src/io/settings/descriptions.js';

test('clause 2: gate.staticLoadAdmission defaults to off in the machine defaults and is described [C7,#8735]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.staticLoadAdmission'], false);
  assert.ok(SETTING_DESCRIPTIONS.some(row => row[0] === 'gate.staticLoadAdmission'), 'the setting has a description row');
});
