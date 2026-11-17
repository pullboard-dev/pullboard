/** A static failure is refused and a clean change settles on the runner with its static and doctrine stages overlapped [V4,V17,C7]. */
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../../tests/fixtures/submit/fail.js';
import { submitAndSettle } from '../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';

test('a static failure is refused and a clean change reaches the gate [V4,C7]', async t => {
  const failing = await project(t, { staticFails: true });
  put(failing.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(failing.box, 'feat(core): change the source [G1]');
  // Process-level: the static preflight refuses in the submitting process before any gate job is offered, so it stays a child.
  const refused = failing.box.run('submit', '1', '--json', '--no-next', '--infra', 'the fail-fast fixture');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /a static problem/u);
  assert.equal(existsSync(failing.markers.staticCheck), true, 'the static check ran');

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
