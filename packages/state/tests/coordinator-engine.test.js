/** @pullboard-test-loads packages/state/src/io/engine/numbers.js */
/** The coordinator usage move keeps its engine number 257, registered in its own leaf, and the registry stays unique and current [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { COORDINATOR_USAGE_ENGINE } from '../light.js';
import { ENGINE_VERSION } from '../light.js';
import { ENGINE_FOLDER } from '../src/io/engine/numbers.js';
import { nextEngineNumber } from '../src/io/engine/numbers.js';
import { readEngineLeaves } from '../src/io/engine/numbers.js';

const leaves = () => readEngineLeaves(resolve(import.meta.dirname, '../../..', ENGINE_FOLDER));

test('COORDINATOR_USAGE_ENGINE is 257 and registered in its own engine leaf [C7]', () => {
  assert.equal(COORDINATOR_USAGE_ENGINE, 257);
  const own = leaves().filter(leaf => leaf.name === 'COORDINATOR_USAGE_ENGINE');
  assert.deepEqual(own.map(leaf => [leaf.file, leaf.number]), [['coordinator-usage-engine.js', 257]]);
});

test('every landed engine number above the legacy shared 145 is unique [C7]', () => {
  const numbers = leaves().map(leaf => leaf.number).filter(number => number !== null && number > 145);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('the current engine is the registry maximum, so a later landing (LANDED_REJECT_ENGINE 258, 274a628a97) raises it on purpose [C7]', () => {
  const all = leaves();
  // An unlanded leaf reads as the next engine until its landing merge numbers it (#1101).
  const highest = all.some(leaf => leaf.number === null) ? nextEngineNumber(all) : Math.max(...all.map(leaf => leaf.number));
  assert.equal(ENGINE_VERSION, highest);
  assert.ok(ENGINE_VERSION >= COORDINATOR_USAGE_ENGINE);
});
