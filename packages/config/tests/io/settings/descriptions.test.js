/** @pullboard-test-input source-cell config */
/** The live-seats-only setting is described under its level name, line.level.liveOnly, and no line.route.liveOnly row remains [C7,#11112]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSetting } from '../../../src/io/settings/descriptions.js';

test('config.settings-descriptions.level-live-only-row: clause 1: the descriptions list line.level.liveOnly with the Live seats only text and no line.route.liveOnly row [C7,#11112]', () => {
  const row = describeSetting('line.level.liveOnly');
  assert.ok(row, 'line.level.liveOnly has a description row');
  assert.equal(row.label, 'Live seats only');
  assert.equal(describeSetting('line.route.liveOnly'), null);
});
