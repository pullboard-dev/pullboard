/** Enrolled runner keys authenticate complete gate results before controller recording [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { runnerSigningKeyPath } from '../packages/runners/src/core/runner-signature.js';
import { signRunnerReceipt } from '../packages/runners/src/core/runner-signature.js';
import { resultFrom } from '../packages/runners/src/shell/runner-result.js';
import { registrationGuiFixture } from './runner-registration-gui-fixture.js';

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

test('the controller refuses a tampered receipt and a signed result for different source [C7]', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pinned = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const spec = { id: 'fixture', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const request = { runner: { host: 'fixture-runner', publicKey: pinned }, spec, phase: 'run' };
  const receipt = { id: spec.id, commit: spec.commit, tree: spec.tree, signature: '' };
  receipt.signature = signRunnerReceipt(receipt, privateKey);
  const tampered = { ...receipt, tree: 'c'.repeat(40) };
  const response = value => ({ status: 0, stdout: Buffer.alloc(0), stderr: `PULLBOARD_RUNNER_RESULT fixture ${Buffer.from(JSON.stringify(value)).toString('base64')}\n` });
  assert.throws(() => resultFrom(request, response(tampered), {}), { code: 'RUNNER_RESULT_SIGNATURE' });
  const wrongSource = { ...receipt, commit: 'd'.repeat(40), signature: '' };
  wrongSource.signature = signRunnerReceipt(wrongSource, privateKey);
  assert.throws(() => resultFrom(request, response(wrongSource), {}), { code: 'RUNNER_RESULT_SOURCE' });
});
