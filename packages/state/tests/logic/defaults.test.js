/** The default next steps name the command or move that fixes a slice path refusal [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_NEXT_STEPS } from '../../src/logic/defaults.js';

test('state.logic-defaults.slice-paths-step: NEXT_STEPS has a SLICE_PATHS row naming the command that fixes it [C7]', () => {
  const line = DEFAULT_NEXT_STEPS.SLICE_PATHS;
  assert.equal(typeof line, 'string', 'the refusal printer reads a SLICE_PATHS row');
  assert.match(line, /revert the outside path/u);
  assert.match(line, /ask the parent holder for a slice that declares it/u);
});
