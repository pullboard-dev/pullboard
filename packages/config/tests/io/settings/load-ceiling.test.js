/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_DEFAULTS } from '../../../src/io/settings/machine-defaults.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';

test('clause 1: machine.loadCeiling is a described machine setting, blank by default so the ceiling is 1.5 times the logical cores [Q1,C7]', () => {
  assert.equal(MACHINE_DEFAULTS['machine.loadCeiling'], null);
  const row = describeSetting('machine.loadCeiling');
  assert.ok(row, 'description row exists');
  assert.match(row.description, /1\.5 times the logical cores/u);
});
