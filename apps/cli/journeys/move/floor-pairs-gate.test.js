/** @pullboard-test-loads packages/moves/src/io/registry.js packages/moves/src/logic/moves/*.js */
/** Pair floor check 2/3: recordGateRun, recordLandingBatch, submit and verify take the larger floor of any two options [C7,V4,H16,#9671]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  floorAloneProblems,
  floorPairProblems,
} from '../../tests/fixtures/move/registry/floor-pairs.js';
import {
  GATE_ALLOW_LIST,
  GATE_TABLES,
} from '../../tests/fixtures/move/registry/floor-pairs-gate.js';

test('clause 1: every option of recordGateRun, recordLandingBatch, submit and verify is listed with its floor, and each pair that fails today is on the allow-list [C7,V4,H16]', () => {
  assert.deepEqual(GATE_TABLES.map(table => table.move), ['recordGateRun', 'recordLandingBatch', 'submit', 'verify']);
  for (const table of GATE_TABLES) {
    assert.ok(table.options.length >= 10, `${table.move} lists its options`);
    for (const option of table.options) {
      assert.ok(Number.isSafeInteger(option.floor) && option.floor > 1, `${table.move}: ${option.name} lists a floor above 1`);
    }
    assert.deepEqual(floorAloneProblems(table), [], `${table.move}: each listed floor is what the option yields alone`);
    const allowed = GATE_ALLOW_LIST.get(table.move);
    assert.ok(Array.isArray(allowed), `${table.move} has an allow-list entry`);
    const failing = floorPairProblems(table);
    assert.deepEqual(failing.filter(line => !allowed.some(name => line.startsWith(`${table.move}: ${name} `))), [], `${table.move}: pairs below the larger floor that the allow-list does not name`);
    for (const name of allowed) assert.ok(failing.some(line => line.startsWith(`${table.move}: ${name} `)), `${table.move}: the allow-list names ${name}, which now passes; remove it`);
  }
});
