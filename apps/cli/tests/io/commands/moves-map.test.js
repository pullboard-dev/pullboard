/** pullboard moves marks a table with no writer as map, not none [C7]. */
/** @pullboard-test-input apps/cli/src/io/commands/moves.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movesReport } from '../../../src/io/commands/moves.js';

const stateOf = (rows, table) => rows.find(row => row.table === table).state;

test('clause 1: a table with no writer reads map, and a table with a writer but no compares keeps none, in the rows and the JSON [C7]', () => {
  const rows = movesReport({}, ['backbone', 'reclaim'], {});
  assert.equal(stateOf(rows, 'backbone'), 'map');
  assert.equal(stateOf(rows, 'reclaim'), 'none');
  assert.equal(stateOf(JSON.parse(JSON.stringify(rows)), 'backbone'), 'map', 'the JSON carries the same state');
  assert.equal(stateOf(JSON.parse(JSON.stringify(rows)), 'reclaim'), 'none');
});

test('clause 2: a mapped table that has a switch reads live or shadow as before [C7]', () => {
  const noWriter = ['claim'];
  assert.equal(stateOf(movesReport({}, ['claim'], { moves: { live: { claim: true } } }, noWriter), 'claim'), 'live');
  assert.equal(stateOf(movesReport({ claim: { compared: 1, disagreed: 0 } }, ['claim'], {}, noWriter), 'claim'), 'shadow');
  assert.equal(stateOf(movesReport({}, ['claim'], {}, noWriter), 'claim'), 'none', 'a switch row means a writer is due, so never map');
});
