/** The controller refuses a tampered receipt and a signed result for different source [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { resultFrom } from '../../index.js';
import { SCREENSHOT_MAX_BYTES } from '../../light.js';
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

/** A green runner response whose receipt carries the given screenshots field, bound to its empty output. */
function withScreenshots(screenshots) {
  const spec = { id: 'fixture', commit: 'a'.repeat(40), tree: 'b'.repeat(40), runtime: { sha256: 'r' }, tooling: { sha256: 't' } };
  const request = { runner: { host: 'fixture-runner' }, spec, phase: 'run' };
  const receipt = { id: spec.id, commit: spec.commit, tree: spec.tree, runtimeSha256: 'r', toolingSha256: 't', code: 0, root: '/fixture', wallMs: 5,
    outputSha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), ...(screenshots === undefined ? {} : { screenshots }) };
  const response = { status: 0, stdout: Buffer.alloc(0), stderr: `PULLBOARD_RUNNER_RESULT fixture ${Buffer.from(JSON.stringify(receipt)).toString('base64')}\n` };
  return () => resultFrom(request, response, {});
}

/** One screenshot entry for a body, with its true size and sha256 unless overridden. */
function shot(path, body, override = {}) {
  return { path, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), base64: body.toString('base64'), ...override };
}

test('runners.result.screenshots-verified: clause 1: resultFrom hands back only screenshots whose size and sha256 match and whose set fits the cap [C7]', () => {
  const body = Buffer.from('png bytes');
  assert.deepEqual(withScreenshots([shot('screenshots/a.png', body)])().screenshots, [shot('screenshots/a.png', body)]);
  assert.equal(withScreenshots(undefined)().screenshots, undefined);
  for (const bad of [
    [shot('screenshots/a.png', body, { sha256: 'f'.repeat(64) })],
    [shot('screenshots/a.png', body, { bytes: body.length + 1 })],
    [shot('screenshots/a.txt', body)],
    [shot('../escape.png', body)],
    [shot('screenshots/a.png', body, { base64: undefined })],
    [shot('screenshots/big.png', Buffer.alloc(SCREENSHOT_MAX_BYTES + 1))],
    'not a list',
  ]) assert.throws(withScreenshots(bad), { name: 'RunnerDropped' });
});

test('runners.result.screenshot-cap: clause 2: SCREENSHOT_MAX_BYTES is 4 MiB and runners/light.js exports it [C7]', () => {
  assert.equal(SCREENSHOT_MAX_BYTES, 4 * 1024 * 1024);
});
