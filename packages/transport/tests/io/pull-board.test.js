/** @pullboard-test-input packages/transport/src/io/pull.js packages/transport/src/io/pull/board.js */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { boardPullAdapter } from '../../index.js';
import { PULL_STORE_FILE } from '../../index.js';
import { pullStatement } from '../../src/io/pull.js';

const TREE = 'f'.repeat(40);
const files = privateFixtureFiles('pullboard-pull-board-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** One board "process": the production builder over the same board folder and trusted key. */
function boot(folder, pub, at) {
  const leases = [];
  const adapter = boardPullAdapter({
    folder, trusted: [pub], now: () => at,
    lease: { take: (job, runner) => { leases.push([job, runner]); return true; }, renew: () => true },
    record: () => {}, checkResult: () => ({ valid: true }), bundle: () => '/dev/null',
  });
  return { adapter, leases };
}

/** The production adapter keeps its state in the board folder, so a take nonce spent before a restart is refused after it [C7]. */
test('the board pull adapter is built over a persistent store and a spent take nonce is refused after a restart [C7]', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64url');
  const folder = join(files.root, 'board');
  const at = 4_000_000;
  const take = (adapter, nonce, when) => adapter.take({ runner: 'r1', at: when, nonce, signature: signText(pullStatement('take', 'r1', when, nonce)) });

  const first = boot(folder, pub, at);
  assert.equal(existsSync(folder), true, 'the builder makes the board folder');
  first.adapter.register({ runner: 'r1', publicKey: pub, at, signature: signText(pullStatement('register', 'r1', at)) });
  first.adapter.open({ host: 'pool' }).startShard({ job: 'gate-8', shard: 's1', command: 'sh run.sh', tree: TREE });
  assert.equal(take(first.adapter, 'spent-nonce-000001', at).job, 'gate-8');
  assert.equal(existsSync(join(folder, PULL_STORE_FILE)), true, 'the state is on disk');

  const second = boot(folder, pub, at + 1000);
  assert.throws(() => take(second.adapter, 'spent-nonce-000001', at), { code: 'PULL_REPLAY' });
  assert.equal(second.leases.length, 0, 'the replay takes no lease');
  assert.doesNotThrow(() => take(second.adapter, 'fresh-nonce-0000001', at + 1000), 'a fresh nonce is accepted after the restart');
});
