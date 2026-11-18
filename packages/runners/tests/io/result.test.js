/** The controller refuses a tampered receipt and a signed result for different source [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { resultFrom } from '../../index.js';
import { signRunnerReceipt } from '../../index.js';

test('runners.result.the-controller-refuses-a-tampered-receipt: the controller refuses a tampered receipt and a signed result for different source [C7]', () => {
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
