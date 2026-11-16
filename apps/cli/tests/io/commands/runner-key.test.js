/** @pullboard-test-input packages/transport/src/io/pull/keys.js apps/cli/src/io/commands/runner.js */
/** A board command issues a key to a named runner and revokes it, and the board's pull adapter honours both [C7]. */
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { sign } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { boardPullAdapter } from '../../../../../packages/transport/index.js';
import { pullStatement } from '../../../../../packages/transport/index.js';

/** A pull adapter over the board folder, as a board process after a (re)start would build it. */
function boardAdapter(box, at) {
  return boardPullAdapter({ folder: join(box.root, '.git', 'pullboard'), now: () => at,
    lease: { take: () => true, renew: () => true }, record: () => {}, checkResult: () => ({ valid: true }), bundle: () => '/dev/null' });
}

/** Sign a register request with the private key the command printed. */
function register(adapter, issued, at) {
  const key = createPrivateKey({ key: Buffer.from(issued.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(pullStatement('register', issued.runner, at)), key).toString('base64url');
  return adapter.register({ runner: issued.runner, publicKey: issued.publicKey, at, signature });
}

test('clause 2: a board command issues a key to a named runner, which then registers with it [C7]', async t => {
  const box = apiHttpFixture(t);
  const ran = await runCliInProcess(['runner', 'key', 'issue', 'pool-1', '--json'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const issued = JSON.parse(ran.stdout).result ?? JSON.parse(ran.stdout);
  assert.equal(issued.runner, 'pool-1');
  assert.deepEqual(register(boardAdapter(box, 4_000_000), issued, 4_000_000), { runner: 'pool-1' });
  const again = await runCliInProcess(['runner', 'key', 'issue', 'pool-1'], { cwd: box.root, env: box.env });
  assert.notEqual(again.status, 0, 'a runner holds one key');
  assert.match(again.stdout + again.stderr, /PULL_KEY_EXISTS/u);
});

test('clause 3: a board command revokes a named runner\'s key, and the runner stays refused after a board restart [C7]', async t => {
  const box = apiHttpFixture(t);
  const ran = await runCliInProcess(['runner', 'key', 'issue', 'pool-2', '--json'], { cwd: box.root, env: box.env });
  const issued = JSON.parse(ran.stdout).result ?? JSON.parse(ran.stdout);
  register(boardAdapter(box, 5_000_000), issued, 5_000_000);
  const revoked = await runCliInProcess(['runner', 'key', 'revoke', 'pool-2'], { cwd: box.root, env: box.env });
  assert.equal(revoked.status, 0, revoked.stdout + revoked.stderr);
  assert.throws(() => register(boardAdapter(box, 5_000_100), issued, 5_000_100), { code: 'PULL_RUNNER_REVOKED' });
  const unknown = await runCliInProcess(['runner', 'key', 'revoke', 'nobody'], { cwd: box.root, env: box.env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /PULL_RUNNER_UNKNOWN/u);
});
