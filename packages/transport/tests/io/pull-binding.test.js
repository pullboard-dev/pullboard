/** @pullboard-test-input packages/transport/src/io/pull.js */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checkSignedResult } from '../../../receipt/index.js';
import { resultStatement } from '../../../receipt/index.js';
import { pullAdapter } from '../../src/io/pull.js';
import { pullStatement } from '../../src/io/pull.js';

const TREE = 'c'.repeat(40);
const GATE = { base: 'd'.repeat(40), tooling: 'e'.repeat(40), attempt: '3' };
const COMMAND = 'sh run.sh';
const BYTES = Buffer.from('PBRESULT 1 0 0\n');

/** An adapter with the real signature check, one registered runner and one shard offered with the gate's binding. */
function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const at = 3_000_000;
  const adapter = pullAdapter({
    trusted: [pub], now: () => at,
    lease: { take: () => true, renew: () => true },
    record: () => {}, checkResult: checkSignedResult, bundle: () => '/dev/null',
  });
  const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64url');
  adapter.register({ runner: 'r1', publicKey: pub, at, signature: signText(pullStatement('register', 'r1', at)) });
  adapter.open({ host: 'pool' }).startShard({ job: 'gate-5', shard: 's1', command: COMMAND, tree: TREE, ...GATE });
  const claim = adapter.take({ runner: 'r1', at, nonce: 'binding-nonce-0001', signature: signText(pullStatement('take', 'r1', at, 'binding-nonce-0001')) });
  /** The signature a runner gives its result when it binds these values. */
  const signResult = bound => signText(resultStatement({ job: 'gate-5', shard: 's1', tree: TREE, digest: createHash('sha256').update(BYTES).digest('hex'), command: COMMAND, ...bound }));
  return { adapter, claim, signResult };
}

/** A take hands the runner the gate's base, tooling pin and attempt, and its result signed over them is accepted [C7]. */
test('transport.pull-binding.a-shard-offered-for-a-gate: a shard offered for a gate carries its base, tooling and attempt into the signed result [C7]', () => {
  const { adapter, claim, signResult } = fixture();
  assert.equal(claim.base, GATE.base);
  assert.equal(claim.tooling, GATE.tooling);
  assert.equal(claim.attempt, GATE.attempt);
  const posted = adapter.post(claim.token, 's1', BYTES, signResult({ base: claim.base, tooling: claim.tooling, attempt: claim.attempt }));
  assert.equal(posted.status, 0);
});

/** A result signed with an empty base, tooling or attempt is refused for a gate that has them [C7]. */
test('transport.pull-binding.a-result-signed-with-an-empty: a result signed with an empty base, tooling or attempt is refused for a gate that has them [C7]', () => {
  for (const empty of ['base', 'tooling', 'attempt']) {
    const { adapter, claim, signResult } = fixture();
    const bound = { base: GATE.base, tooling: GATE.tooling, attempt: GATE.attempt, [empty]: '' };
    assert.throws(() => adapter.post(claim.token, 's1', BYTES, signResult(bound)), { code: 'PULL_RESULT_INVALID' }, `${empty} left empty`);
  }
});
