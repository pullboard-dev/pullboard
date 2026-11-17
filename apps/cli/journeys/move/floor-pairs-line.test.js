/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js */
/** Pair floor check 3/3: setLineSetting takes the larger floor of any two options [C7,V4,H16,#9672]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  floorAloneProblems,
  floorPairProblems,
} from '../../tests/fixtures/move/registry/floor-pairs.js';
import {
  LINE_ALLOW_LIST,
  LINE_TABLE,
} from '../../tests/fixtures/move/registry/floor-pairs-line.js';

test('clause 1: every setLineSetting key that raises its floor is listed with that floor, and each pair below the larger floor is on the allow-list with its conflict named [C7,V4,H16]', () => {
  assert.equal(LINE_TABLE.move, 'setLineSetting');
  const keys = LINE_TABLE.options.filter(option => option.group === 'key');
  assert.ok(keys.length >= 8, 'the table lists the setting keys');
  for (const option of LINE_TABLE.options) {
    assert.ok(Number.isSafeInteger(option.floor) && option.floor > 1, `${option.name} lists a floor above 1`);
  }
  assert.deepEqual(floorAloneProblems(LINE_TABLE), [], 'each listed floor is what the option yields alone');
  const failing = floorPairProblems(LINE_TABLE);
  const named = (line, entry) => line.startsWith(`${LINE_TABLE.move}: ${entry.pair} `);
  assert.deepEqual(failing.filter(line => !LINE_ALLOW_LIST.some(entry => named(line, entry))), [], 'pairs below the larger floor that the allow-list does not name');
  for (const entry of LINE_ALLOW_LIST) {
    assert.ok(entry.conflict.length > 10, `${entry.pair} names its conflict`);
    assert.ok(failing.some(line => named(line, entry)), `the allow-list names ${entry.pair}, which now passes; remove it`);
  }
});
