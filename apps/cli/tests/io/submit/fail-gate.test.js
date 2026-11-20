/** A static failure is refused before any gate job is offered [V4,V17,C7]. */
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../../fixtures/submit/fail.js';
import { submitStep } from '../../fixtures/submit/fail.js';
import { commitAll } from '../../fixtures/submit/gate.js';
import { put } from '../../fixtures/submit/gate.js';

test('cli.journeys-submit-fail-gate.a-static-failure-is-refused-before: clause 2: a static failure is refused before any gate job is offered [V4,C7]', async t => {
  const failing = await project(t, { staticFails: true });
  put(failing.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(failing.box, 'feat(core): change the source [G1]');
  // The static preflight refuses in the submitting process before any gate job is offered; that process is this one, or a real child under PULLBOARD_JOURNEY_MODE=process [C7,#10458].
  const refused = await submitStep(failing.box, 'submit', '1', '--json', '--no-next', '--infra', 'the fail-fast fixture');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /a static problem/u);
  assert.equal(existsSync(failing.markers.staticCheck), true, 'the static check ran');
});
