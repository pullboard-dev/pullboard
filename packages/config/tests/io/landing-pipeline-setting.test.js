/** The landing.pipeline setting is a described on/off setting, off unless a project sets it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../index.js';
import { SETTING_DESCRIPTIONS } from '../../index.js';

test('config.io-landing-pipeline-setting.clause-1-landing-pipeline-defaults-off: clause 1: landing.pipeline defaults off and accepts only a boolean [C7]', () => {
  assert.equal(configFromSource('{}').landing?.pipeline, undefined, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"landing":{"pipeline":true}}').landing.pipeline, true, 'a project may turn it on');
  assert.throws(() => configFromSource('{"landing":{"pipeline":"yes"}}'), /landing\.pipeline/u, 'only a boolean is accepted');
});

test('config.io-landing-pipeline-setting.clause-2-descriptions-js-has-a-landing: clause 2: descriptions.js has a landing.pipeline on/off row that pullboard settings prints [C7]', () => {
  assert.equal(SETTING_DESCRIPTIONS['landing.pipeline'].unit, 'on/off');
  assert.match(SETTING_DESCRIPTIONS['landing.pipeline'].description, /second landing batch/u);
});
