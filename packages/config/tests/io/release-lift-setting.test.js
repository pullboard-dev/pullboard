/** The release.liftTwiceHold setting is a described on/off setting, off unless a project sets it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../index.js';
import { SETTING_DESCRIPTIONS } from '../../index.js';

test('config.io-release-lift-setting.clause-1-release-lifttwicehold-defaults: clause 1: release.liftTwiceHold defaults off and accepts only a boolean [C7]', () => {
  assert.equal(configFromSource('{}').release?.liftTwiceHold, undefined, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"release":{"liftTwiceHold":true}}').release.liftTwiceHold, true, 'a project may turn it on');
  assert.throws(() => configFromSource('{"release":{"liftTwiceHold":"yes"}}'), /liftTwiceHold/u, 'only a boolean is accepted');
});

test('config.io-release-lift-setting.clause-1-descriptions-js-has-a-release: clause 1: descriptions.js has a release.liftTwiceHold on/off row that pullboard settings prints [C7]', () => {
  assert.equal(SETTING_DESCRIPTIONS['release.liftTwiceHold'].unit, 'on/off');
  assert.match(SETTING_DESCRIPTIONS['release.liftTwiceHold'].description, /main moves/u);
});
