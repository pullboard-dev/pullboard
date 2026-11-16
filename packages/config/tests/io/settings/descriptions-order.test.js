/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_DESCRIPTIONS } from '../../../src/io/settings/descriptions.js';

test('clause 2: gate.viewTimerLayout has a description row that says what it refuses and that off reports nothing [C7]', () => {
  const row = SETTING_DESCRIPTIONS['gate.viewTimerLayout'];
  assert.ok(row, 'gate.viewTimerLayout has a description row');
  assert.match(row.description, /refuses/);
  assert.match(row.description, /off, it reports nothing/);
  assert.equal(row.unit, 'on/off');
});
