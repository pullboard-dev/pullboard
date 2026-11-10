/** An enrolled runner signs its complete gate result and the controller accepts it [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  statSync,
} from 'node:fs';
import { test } from 'node:test';
import { runnerSigningKeyPath } from '../../../../packages/runners/index.js';
import { registrationGuiFixture } from '../../tests/fixtures/runner/gui.js';

test('a registered fake runner signs its green result and the controller accepts it [C7]', async t => {
  const box = registrationGuiFixture(t);
  const runner = box.register();
  assert.match(runner.publicKey, /^[A-Za-z0-9_-]{59}$/u);
  const privateKey = runnerSigningKeyPath(box.remoteMachine, runner.publicKey);
  assert.equal(existsSync(privateKey), true, 'the signing key stays in the runner machine home');
  assert.equal(statSync(privateKey).mode & 0o077, 0, 'the signing key is owner-only');
  const result = await box.runGui();
  assert.equal(result.status, 0, result.context);
  assert.equal(box.result(result.stdout).isGreen, true);
});
