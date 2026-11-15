/** @pullboard-test-loads packages/state/src/io/engine/numbers.js */
/** The coordinator usage move is numbered one above every other engine [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { COORDINATOR_USAGE_ENGINE } from '../light.js';
import { ENGINE_FOLDER } from '../src/io/engine/numbers.js';
import { readEngineLeaves } from '../src/io/engine/numbers.js';

test('COORDINATOR_USAGE_ENGINE is one above the highest other engine number [C7]', () => {
  const others = readEngineLeaves(resolve(import.meta.dirname, '../../..', ENGINE_FOLDER)).filter(leaf => leaf.name !== 'COORDINATOR_USAGE_ENGINE');
  assert.equal(COORDINATOR_USAGE_ENGINE, Math.max(...others.map(leaf => leaf.number ?? 0)) + 1);
});
