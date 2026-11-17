/** A static failure is refused before any gate job is offered [V4,V17,C7]. */
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../../tests/fixtures/submit/fail.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';

test('clause 2: a static failure is refused before any gate job is offered [V4,C7]', async t => {
  const failing = await project(t, { staticFails: true });
  put(failing.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(failing.box, 'feat(core): change the source [G1]');
  // Process-level: the static preflight refuses in the submitting process before any gate job is offered, so it stays a child.
  const refused = failing.box.run('submit', '1', '--json', '--no-next', '--infra', 'the fail-fast fixture');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /a static problem/u);
  assert.equal(existsSync(failing.markers.staticCheck), true, 'the static check ran');
});
