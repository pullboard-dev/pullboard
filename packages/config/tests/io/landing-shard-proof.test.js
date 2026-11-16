/** The landing.shardProof setting is a described on/off setting, off unless a project sets it [C7,#7818,#8255]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../index.js';
import { SETTING_DESCRIPTIONS } from '../../index.js';

test('clause 1: landing.shardProof defaults off, is a described on/off setting and accepts only a boolean [C7,#8255]', () => {
  assert.equal(configFromSource('{}').landing?.shardProof, undefined, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"landing":{"shardProof":true}}').landing.shardProof, true, 'a project may turn it on');
  assert.equal(SETTING_DESCRIPTIONS['landing.shardProof'].unit, 'on/off', 'it is a described on/off setting');
  assert.throws(() => configFromSource('{"landing":{"shardProof":"yes"}}'), /landing\.shardProof/u, 'only a boolean is accepted');
});
