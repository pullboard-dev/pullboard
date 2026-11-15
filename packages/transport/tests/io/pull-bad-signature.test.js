/** A pull runner's result with a bad signature is import.invalid, an infra outcome that is retried, never a red test [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { pullAdapter } from '../../index.js';
import { pullStatement } from '../../index.js';
import { checkSignedResult } from '../../../receipt/index.js';

test('clause 1: [C7] a runner result with an invalid signature is recorded as import.invalid, an infra outcome that retries, and never as a failing test', async () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const sig = (action, at, nonce) => sign(null, Buffer.from(pullStatement(action, 'r1', at, nonce)), keys.privateKey).toString('base64url');
  const recorded = [];
  const adapter = pullAdapter({
    trusted: [publicKey],
    lease: { take: () => true, renew: () => true },
    record: (job, shard, payload) => recorded.push({ job, shard, payload }),
    checkResult: checkSignedResult,
    bundle: () => '/dev/null',
  });
  const at = Date.now();
  adapter.register({ runner: 'r1', publicKey, at, signature: sig('register', at) });
  const channel = adapter.open({ host: 'r1' });
  const tree = 'a'.repeat(40);
  await channel.startShard({ job: 'gate-1', shard: 's1', command: 'true', tree });
  const { token } = adapter.take({ runner: 'r1', at, nonce: 'bad-signature-nonce-1', signature: sig('take', at, 'bad-signature-nonce-1') });

  assert.throws(() => adapter.post(token, 's1', Buffer.from('PBRESULT 1 1 0\n'), 'A'.repeat(86)), { code: 'PULL_RESULT_INVALID' });
  const read = await channel.fetchResult({ job: 'gate-1', shard: 's1' });
  assert.equal(read.state, 'import.invalid', 'the board reads it as import.invalid, which the driver restarts');
  assert.match(read.reason, /signature/u);
  assert.equal(read.status, undefined, 'it carries no test status, so it can never be a failing test');
  assert.deepEqual(recorded, [], 'no done step, so no red or green is recorded');
  assert.equal((await channel.fetchResult({ job: 'gate-1', shard: 's1' })).state, 'running', 'after the reset the shard is offered again');
  channel.close();
});
