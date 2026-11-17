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
function boardAdapter(root, at) {
  return boardPullAdapter({ folder: join(root, '.git', 'pullboard'), now: () => at,
    lease: { take: () => true, renew: () => true }, record: () => {}, checkResult: () => ({ valid: true }), bundle: () => '/dev/null' });
}

/** Register with the private key the command printed. */
function register(adapter, issued, at) {
  const key = createPrivateKey({ key: Buffer.from(issued.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(pullStatement('register', issued.runner, at)), key).toString('base64url');
  return adapter.register({ runner: issued.runner, publicKey: issued.publicKey, at, signature });
}

test('cli.io-commands-runner-key.a-board-command-issues-a-key-to: clause 2: a board command issues a key to a named runner; clause 3: another revokes it and the runner stays refused after a board restart [C7]', async t => {
  const box = apiHttpFixture(t);
  const root = box.root;
  const run = (...args) => runCliInProcess(['runner', 'key', ...args], { cwd: root, env: box.env });
  const ran = await run('issue', 'pool-1', '--json');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const parsed = JSON.parse(ran.stdout);
  const issued = parsed.result ?? parsed;
  assert.equal(issued.runner, 'pool-1');
  assert.deepEqual(register(boardAdapter(root, 4_000_000), issued, 4_000_000), { runner: 'pool-1' });
  const again = await run('issue', 'pool-1');
  assert.match(again.stdout + again.stderr, /PULL_KEY_EXISTS/u);
  const revoked = await run('revoke', 'pool-1');
  assert.equal(revoked.status, 0, revoked.stdout + revoked.stderr);
  assert.throws(() => register(boardAdapter(root, 4_000_100), issued, 4_000_100), { code: 'PULL_RUNNER_REVOKED' });
  const unknown = await run('revoke', 'nobody');
  assert.match(unknown.stdout + unknown.stderr, /PULL_RUNNER_UNKNOWN/u);
});
