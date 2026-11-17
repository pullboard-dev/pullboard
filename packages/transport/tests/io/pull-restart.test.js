/** @pullboard-test-input packages/transport/src/io/pull.js packages/transport/src/io/pull/store.js */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { pullAdapter } from '../../src/io/pull.js';
import { pullStatement } from '../../src/io/pull.js';
import { fileStore } from '../../src/io/pull/store.js';

const TREE = 'b'.repeat(40);
const files = privateFixtureFiles('pullboard-pull-restart-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** One board "process": a fresh adapter over the same store file and the same trusted key. */
function boot(path, pub, at) {
  const leases = [];
  const adapter = pullAdapter({
    trusted: [pub], now: () => at, store: fileStore(path),
    lease: { take: (job, runner) => { leases.push([job, runner]); return true; }, renew: () => true },
    record: () => {}, checkResult: () => ({ valid: true }), bundle: () => '/dev/null',
  });
  return { adapter, leases };
}

/** A pull offer made before a board restart is still offered and takeable after it [C7]. */
test('transport.pull-restart.a-pull-offer-made-before-a: a pull offer made before a board restart is still takeable after the restart [C7]', () => {
  const dir = files.root;
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64url');
    const path = join(dir, 'pull.json');
    const at = 2_000_000;

    const first = boot(path, pub, at);
    first.adapter.register({ runner: 'r1', publicKey: pub, at, signature: signText(pullStatement('register', 'r1', at)) });
    first.adapter.open({ host: 'pool' }).startShard({ job: 'gate-9', shard: 's1', command: 'sh run.sh', tree: TREE });

    const second = boot(path, pub, at + 1000);
    const later = at + 1000;
    const job = second.adapter.take({ runner: 'r1', at: later, nonce: 'restart-nonce-0001', signature: signText(pullStatement('take', 'r1', later, 'restart-nonce-0001')) });
    assert.equal(job.job, 'gate-9');
    assert.deepEqual(job.shards, [{ shard: 's1', command: 'sh run.sh' }]);
    assert.equal(job.tree, TREE);
    assert.deepEqual(second.leases, [['gate-9', 'r1']]);
  }
});

/** A missing store file is an empty book [C7]. */
test('transport.pull-restart.a-missing-store-file-starts-an: a missing store file starts an empty book [C7]', () => {
  const dir = files.root;
  {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const store = fileStore(join(dir, 'missing.json'));
    assert.equal(store.load(), null);
    assert.doesNotThrow(() => boot(join(dir, 'missing.json'), pub, 1));
  }
});

/** A revocation made before a board restart still refuses the runner after it [C7]. */
test('transport.pull-restart.a-runner-revoked-before-a-board: clause 1: a runner revoked before a board restart is still refused its pulls and cannot register again [C7]', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64url');
  const path = join(files.root, 'revoked.json');
  const at = 3_000_000;
  const first = boot(path, pub, at);
  first.adapter.register({ runner: 'r1', publicKey: pub, at, signature: signText(pullStatement('register', 'r1', at)) });
  first.adapter.open({ host: 'pool' }).startShard({ job: 'gate-1', shard: 's1', command: 'sh run.sh', tree: TREE });
  first.adapter.revoke('r1');

  const second = boot(path, pub, at + 1000);
  const later = at + 1000;
  assert.throws(() => second.adapter.take({ runner: 'r1', at: later, nonce: 'revoked-nonce-0001', signature: signText(pullStatement('take', 'r1', later, 'revoked-nonce-0001')) }), { code: 'PULL_RUNNER_REVOKED' });
  assert.throws(() => second.adapter.register({ runner: 'r1', publicKey: pub, at: later, signature: signText(pullStatement('register', 'r1', later)) }), { code: 'PULL_RUNNER_REVOKED' });
  assert.deepEqual(second.leases, [], 'no lease was taken for the revoked runner');
});
