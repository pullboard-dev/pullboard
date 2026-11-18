/** verify.failBefore is a boolean setting, off by default, and listed with its description [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblems } from '../../src/io/main.js';
import { defaults } from '../../src/io/main.js';
import { describeSetting } from '../../src/io/settings/descriptions.js';

test('config.io-fail-before-setting.clause-1-verify-failbefore-defaults-to: clause 1: verify.failBefore defaults to false and must be a boolean [C7]', () => {
  assert.equal(defaults().verify.failBefore, false);
  assert.deepEqual(configProblems(defaults()).filter(p => p.includes('failBefore')), []);
  const bad = { ...defaults(), verify: { ...defaults().verify, failBefore: 'yes' } };
  assert.ok(configProblems(bad).some(p => p.includes('failBefore')));
});

test('config.io-fail-before-setting.clause-3-verify-failbefore-is-described: clause 3: verify.failBefore is described for pullboard settings [C7]', () => {
  assert.match(JSON.stringify(describeSetting('verify.failBefore')), /fail-before|failed on an assertion/u);
});

test('config.io-fail-before-setting.verify-frozentests-defaults-to-false: verify.frozenTests defaults to false, must be a boolean, and is described [C7]', () => {
  assert.equal(defaults().verify.frozenTests, false);
  const bad = { ...defaults(), verify: { ...defaults().verify, frozenTests: 'yes' } };
  assert.ok(configProblems(bad).some(p => p.includes('frozenTests')));
  assert.match(JSON.stringify(describeSetting('verify.frozenTests')), /test file/u);
});
