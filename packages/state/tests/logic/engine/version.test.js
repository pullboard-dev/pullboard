import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINE_VERSION as lightVersion } from '../../../light.js';
import { ENGINE_VERSION } from '../../../index.js';

test('the light door names the same engine version the engines folder declares [C7,H16]', () => {
  assert.equal(lightVersion, ENGINE_VERSION);
});
