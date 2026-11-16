/** @pullboard-test-input source-cell config */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSetting } from '../../../src/io/settings/descriptions.js';

test('clause 2: gate.idiomSpread has a description row that says what it refuses and that off reports nothing [C7]', () => {
  const row = describeSetting('gate.idiomSpread');
  assert.ok(row, 'description row exists');
  assert.match(row.description, /refuses/u);
  assert.match(row.description, /idiom/u);
  assert.match(row.description, /off, it reports nothing/u);
});
