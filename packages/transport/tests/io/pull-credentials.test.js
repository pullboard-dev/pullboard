/** @pullboard-test-input packages/transport/src/io/pull.js */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { pullAdapter } from '../../src/io/pull.js';
import { pullStatement } from '../../src/io/pull.js';

const TREE = 'c'.repeat(40);
const AT = 3_000_000;

/** A runner with a key of its own: its public half and a signer. */
function credential() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), sign: text => sign(null, Buffer.from(text), privateKey).toString('base64url') };
}

/** A board that trusts every given credential, with one job offered per runner pull. */
function board(credentials) {
  const adapter = pullAdapter({
    trusted: credentials.map(credential => credential.pub), now: () => AT,
    lease: { take: () => true, renew: () => true },
    record: () => {}, checkResult: () => ({ valid: true }), bundle: () => '/dev/null',
  });
  const register = (runner, credential) => adapter.register({ runner, publicKey: credential.pub, at: AT, signature: credential.sign(pullStatement('register', runner, AT)) });
  let taken = 0;
  const take = (runner, credential) => {
    const nonce = `credentials-nonce-${String(++taken).padStart(6, '0')}`;
    return adapter.take({ runner, at: AT, nonce, signature: credential.sign(pullStatement('take', runner, AT, nonce)) });
  };
  const offer = job => adapter.open({ host: 'pool' }).startShard({ job, shard: 's1', command: 'sh run.sh', tree: TREE });
  return { adapter, register, take, offer };
}

/** Each runner pulls with a credential issued to it alone [C7]. */
test('transport.pull-credentials.a-key-is-one-runner-s: a key is one runner\'s credential: a second runner cannot register with it [C7]', () => {
  const [one, two] = [credential(), credential()];
  const { register, take, offer } = board([one, two]);
  register('r1', one);
  assert.throws(() => register('r2', one), { code: 'PULL_KEY_SHARED' });
  register('r2', two);
  offer('gate-1');
  assert.equal(take('r1', one).job, 'gate-1');
  assert.throws(() => take('r2', one), { code: 'PULL_SIGNATURE' }, 'one runner cannot pull under another runner\'s credential');
});

/** Revoking one runner's credential stops its pulls and leaves the others working [C7]. */
test('transport.pull-credentials.revoking-one-runner-stops-its-pulls: revoking one runner stops its pulls and leaves the others working [C7]', () => {
  const [one, two] = [credential(), credential()];
  const { adapter, register, take, offer } = board([one, two]);
  register('r1', one);
  register('r2', two);
  offer('gate-2');
  assert.deepEqual(adapter.revoke('r1'), { revoked: true });
  assert.throws(() => take('r1', one), { code: 'PULL_RUNNER_REVOKED' });
  assert.throws(() => register('r1', one), { code: 'PULL_RUNNER_REVOKED' }, 'a revoked key cannot register again');
  assert.equal(take('r2', two).job, 'gate-2');
});
