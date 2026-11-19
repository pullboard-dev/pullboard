/** @pullboard-test-input packages/transport/src/io/pull.js packages/transport/src/io/pull/board.js */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { jobsPullPorts } from '../../../jobs/index.js';
import { checkSignedResult } from '../../../receipt/index.js';
import { resultStatement } from '../../../receipt/index.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { boardPullAdapter } from '../../index.js';
import { pullStatement } from '../../src/io/pull.js';

const TREE = 'a'.repeat(40);
const COMMAND = 'sh run.sh';
const BYTES = Buffer.from('PBRESULT 1 0 0\n');
const files = privateFixtureFiles('pullboard-pull-jobs-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** A SQLite board with one queued job, and the production adapter bound to its jobs table with one registered runner. */
function fixture(t) {
  const db = cellBoard(t, ':memory:').db;
  const at = 5_000_000;
  createJob(db, { id: 'gate-9', kind: 'gate', now: 1 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const signText = text => sign(null, Buffer.from(text), privateKey).toString('base64url');
  const adapter = boardPullAdapter({ folder: join(files.root, `board-${Math.random().toString(36).slice(2)}`), trusted: [pub], now: () => at, ...jobsPullPorts(db, { now: () => at }), checkResult: checkSignedResult, bundle: () => '/dev/null' });
  adapter.register({ runner: 'r1', publicKey: pub, at, signature: signText(pullStatement('register', 'r1', at)) });
  adapter.open({ host: 'pool' }).startShard({ job: 'gate-9', shard: 's1', command: COMMAND, tree: TREE });
  const nonce = 'jobs-nonce-00000001';
  return { db, adapter, signText, at, take: () => adapter.take({ runner: 'r1', at, nonce, signature: signText(pullStatement('take', 'r1', at, nonce)) }) };
}

test('transport.pull-jobs.boardpulladapter-built-with-jobs-table-ports: clause 1: boardPullAdapter built with jobs-table ports on a SQLite board leases a queued job to a trusted runner take [C7]', t => {
  const { db, take } = fixture(t);
  assert.equal(jobView(db, 'gate-9').leaseOwner, null, 'the queued job is unleased');
  const claim = take();
  assert.equal(claim.job, 'gate-9');
  assert.equal(jobView(db, 'gate-9').leaseOwner, 'r1', 'the job row names the runner that took it');
});

test('transport.pull-jobs.a-result-posted-through-the-adapter: clause 2: a result posted through the adapter is recorded on the job row [C7]', t => {
  const { db, adapter, signText, take } = fixture(t);
  const { token } = take();
  const digest = createHash('sha256').update(BYTES).digest('hex');
  const signature = signText(resultStatement({ job: 'gate-9', shard: 's1', tree: TREE, digest, command: COMMAND, base: '', tooling: '', attempt: '' }));
  assert.equal(adapter.post(token, 's1', BYTES, signature).digest, digest);
  const view = jobView(db, 'gate-9');
  assert.equal(view.step, 'shard.s1', 'the job row moved to the shard step');
  assert.equal(view.steps.at(-1).payload.digest, digest);
  assert.equal(view.steps.at(-1).payload.runner, 'r1');
});
