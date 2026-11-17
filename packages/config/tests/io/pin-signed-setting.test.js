/** pin.signed is a boolean setting, off by default, and listed with its description [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';
import { configProblems } from '../../src/io/main.js';
import { defaults } from '../../src/io/main.js';
import { describeSetting } from '../../src/io/settings/descriptions.js';

test('config.io-pin-signed-setting.clause-2-pin-signed-defaults-to-false: clause 2: pin.signed defaults to false, must be a boolean, and is described [C7]', () => {
  assert.equal(defaults().pin.signed, false);
  assert.equal(configFromSource('{}').pin.signed, false);
  assert.equal(configFromSource('{"pin":{"signed":true}}').pin.signed, true);
  assert.ok(configProblems({ ...defaults(), pin: { signed: 'yes' } }).some(p => p.includes('pin.signed')));
  assert.match(JSON.stringify(describeSetting('pin.signed')), /tooling pin/u);
});
