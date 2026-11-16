/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSetting } from '../../../src/io/settings/descriptions.js';

test('clause 2: gate.adapterLintTimers has a description row that says what it refuses and that off reports nothing [C7]', () => {
  const row = describeSetting('gate.adapterLintTimers');
  assert.ok(row, 'description row exists');
  assert.match(row.description, /refuses/u);
  assert.match(row.description, /timer/u);
  assert.match(row.description, /off, it reports nothing/u);
});
