/** A clean change settles on the runner with its static and doctrine stages overlapped [V4,V17,C7]. */
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../../../tests/fixtures/submit/fail.js';
import { submitAndSettle } from '../../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { put } from '../../../tests/fixtures/submit/gate.js';

test('clause 1: a clean change reaches the gate with the static and doctrine stages overlapped [V4,C7]', async t => {
  const clean = await project(t, { staticWaitsForDoctrine: true });
  put(clean.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(clean.box, 'feat(core): change the source [G1]');
  const accepted = await submitAndSettle(t, clean.box);
  assert.equal(accepted.gate?.green, true, JSON.stringify(accepted.gate));
  assert.equal(existsSync(clean.markers.staticCheck), true, 'the static check ran');
  assert.equal(existsSync(clean.markers.doctrine), true, 'the doctrine rule ran');
  assert.equal(existsSync(clean.markers.item), true, 'the item check ran');
  // The static check only passes after the doctrine marker exists, so a green submit proves the two stages overlapped.
});
