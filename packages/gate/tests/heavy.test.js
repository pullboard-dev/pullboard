/** The gate heavy door carries every name the gate index exports, so importers can leave the index one cell at a time [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as heavy from '../heavy.js';
import * as index from '../index.js';
import * as light from '../light.js';

/** The index names status still reads from the index itself. */
const STAYS = new Set(['diskStores', 'gateControlFindings', 'performanceCores', 'retainedReceipts']);

test('gate.heavy.exports-index-heavy-names: clause 1: every index export except the light door names and four status names is also exported by heavy.js as the same binding [C7]', () => {
  const names = Object.keys(index).filter(name => !(name in light) && !STAYS.has(name));
  assert.ok(names.length > 400, 'the index still exports its heavy names');
  const missing = names.filter(name => !(name in heavy));
  assert.deepEqual(missing, [], 'heavy.js exports every index heavy name');
  const other = names.filter(name => heavy[name] !== index[name]);
  assert.deepEqual(other, [], 'each heavy name is the index binding');
});
