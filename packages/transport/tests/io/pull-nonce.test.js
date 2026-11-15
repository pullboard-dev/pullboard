/** @pullboard-test-input packages/transport/src/io/pull.js */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { pullAdapter } from '../../src/io/pull.js';
import { pullStatement } from '../../src/io/pull.js';

const TREE = 'a'.repeat(40);

/** An adapter with one registered runner and one offered job; `leases` counts every lease taken. */
function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const clock = { at: 1_000_000 };
  const leases = [];
  const adapter = pullAdapter({
    trusted: [pub], now: () => clock.at,
    lease: { take: (job, runner) => { leases.push([job, runner]); return true; }, renew: () => true },
    record: () => {}, checkResult: () => ({ valid: true }), bundle: () => '/dev/null',
  });
  const sign64 = (text) => sign(null, Buffer.from(text), privateKey).toString('base64url');
  adapter.register({ runner: 'r1', publicKey: pub, at: clock.at, signature: sign64(pullStatement('register', 'r1', clock.at)) });
  adapter.open({ host: 'pool' }).startShard({ job: 'gate-1', shard: 's1', command: 'sh run.sh', tree: TREE });
  const take = (nonce, at = clock.at) => adapter.take({ runner: 'r1', at, nonce, signature: sign64(pullStatement('take', 'r1', at, nonce)) });
  return { adapter, clock, leases, take, sign64 };
}

/** The statement a take signs includes its nonce [C7]. */
test('a pull take request includes a single-use nonce [C7]', () => {
  assert.equal(pullStatement('take', 'r1', 5, 'abc'), 'PBTAKE 1 r1 5 abc');
  const { take, leases } = fixture();
  const job = take('nonce-aaaaaaaaaaaa');
  assert.equal(job.job, 'gate-1');
  assert.equal(leases.length, 1);
});

/** A take without a well-formed nonce is refused before any lease [C7]. */
test('a take with no nonce is refused and takes no lease [C7]', () => {
  const { adapter, clock, leases, sign64 } = fixture();
  assert.throws(() => adapter.take({ runner: 'r1', at: clock.at, signature: sign64(pullStatement('take', 'r1', clock.at)) }), { code: 'PULL_NONCE' });
  assert.equal(leases.length, 0);
});

/** Replaying an accepted take in its window is refused and takes no lease [C7]. */
test('a replayed take is refused and takes no lease [C7]', () => {
  const { take, leases, clock } = fixture();
  const at = clock.at;
  take('nonce-bbbbbbbbbbbb');
  assert.equal(leases.length, 1);
  assert.throws(() => take('nonce-bbbbbbbbbbbb', at), { code: 'PULL_REPLAY' });
  clock.at += 1000;
  assert.throws(() => take('nonce-bbbbbbbbbbbb', at), { code: 'PULL_REPLAY' }, 'still inside the freshness window');
  assert.equal(leases.length, 1);
  assert.doesNotThrow(() => take('nonce-cccccccccccc'), 'a fresh nonce is accepted');
});

/** A forged nonce does not use up the real one: the signature is checked first [C7]. */
test('a take whose signature does not cover the nonce is refused [C7]', () => {
  const { adapter, clock, sign64 } = fixture();
  const signature = sign64(pullStatement('take', 'r1', clock.at, 'nonce-dddddddddddd'));
  assert.throws(() => adapter.take({ runner: 'r1', at: clock.at, nonce: 'nonce-eeeeeeeeeeee', signature }), { code: 'PULL_SIGNATURE' });
});
