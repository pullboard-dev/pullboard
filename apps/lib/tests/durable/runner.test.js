/** Durable gate 27: a hosted pull runner registers a trusted key, takes a job by lease, fetches its bundle, posts a signed result [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { openBoard } from '../../index.js';
import { closeBoard } from '../../index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { renewLease } from '../../../../packages/jobs/index.js';
import { releaseLease } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { treeOf } from '../../../../packages/pin/index.js';
import { bundleFor } from '../../../../packages/pin/index.js';
import { checkSignedResult } from '../../../../packages/receipt/index.js';
import { resultStatement } from '../../../../packages/receipt/index.js';
import { createTransport } from '../../../../packages/transport/index.js';
import { pullAdapter } from '../../../../packages/transport/index.js';
import { pullServer } from '../../../../packages/transport/index.js';
import { pullRunner } from '../../../../packages/transport/index.js';

const files = privateFixtureFiles('pullboard-pull-runner-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** A runner key pair as the runner enrolment names keys: base64url SPKI DER public, PKCS#8 PEM private. */
function runnerKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    key: pair.privateKey,
  };
}

/** A project repo whose own test command is a plain shell script, so nothing assumes Node on the runner. */
function projectRepo(name) {
  const repo = join(files.root, name);
  files.write(`${name}/check.sh`, 'printf "project check ok\\n"\n');
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'pull@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Pull Test']);
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'project']);
  return { repo, tree: treeOf(repo, 'HEAD') };
}

/**
 * The board side: a real board file, the jobs cell leasing the gate job row itself to the runner that takes it, one
 * writeStep per accepted result, and the HTTP server on a loopback port.
 */
async function boardFixture(name, trusted) {
  const { repo, tree } = projectRepo(name);
  const board = openBoard(':memory:');
  const db = board.db;
  const seqs = new Map();
  const adapter = pullAdapter({
    trusted: () => trusted,
    lease: {
      take: (job, runner) => takeJob(db, job, runner).taken,
      renew: (job, runner) => renewLease(db, job, runner),
    },
    record: (job, shard, payload) => {
      if (!seqs.has(shard)) seqs.set(shard, seqs.size + 1);
      writeStep(db, job, 'shard.done', { shard, ...payload }, { seq: seqs.get(shard) });
    },
    checkResult: checkSignedResult,
    bundle: candidate => bundleFor(repo, candidate, join(files.root, `${name}-bundles`)).path,
  });
  const server = pullServer(adapter);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const transport = createTransport({ adapter });
  return {
    db, tree, adapter, url, transport,
    lease: job => db.prepare('SELECT job_lease_owner AS owner, job_lease_until AS until FROM job WHERE job_id = ?').get(job),
    steps: job => db.prepare('SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ?').get(job).n,
    async close() { transport.close(); await new Promise(resolve => server.close(resolve)); closeBoard(board); },
  };
}

/** POST JSON or bytes to the board and return status and parsed body. */
async function call(url, path, body, headers = {}) {
  const response = await fetch(new URL(path, url), { method: 'POST', body, headers });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

test('clause 1: a pull runner with no inbound connection registers, takes the gate job by lease, fetches its tree bundle by tree id, runs the project command and posts a result file the board records in one write [C7]', async () => {
  const keys = runnerKeys();
  const board = await boardFixture('one-job', [keys.publicKey]);
  try {
    createJob(board.db, { id: 'gate-1', kind: 'gate', item: 27 });
    const channel = board.transport.connect({ host: 'pull-pool' });
    assert.deepEqual(await channel.startShard({ job: 'gate-1', shard: 's1', command: 'sh ./check.sh', tree: board.tree }), { state: 'started', job: 'gate-1', shard: 's1' });
    assert.deepEqual(await channel.fetchResult({ job: 'gate-1', shard: 's1' }), { state: 'running' });

    const runner = pullRunner({ board: board.url, runner: 'sandbox-1', publicKey: keys.publicKey, privateKey: keys.privateKey, workdir: join(files.root, 'sandbox-1') });
    assert.deepEqual(await runner.register(), { runner: 'sandbox-1' });
    assert.equal(takeJob(board.db, 'gate-1', 'driver-a').taken, true);
    assert.equal(await runner.runOnce(), null, 'a gate job whose lease another holder keeps live is not handed to a runner');
    assert.equal(board.lease('gate-1').owner, 'driver-a', 'a refused take leaves the live lease where it was');
    assert.equal(releaseLease(board.db, 'gate-1', 'driver-a'), true);
    const before = board.steps('gate-1');
    const ran = await runner.runOnce();
    assert.equal(ran.job, 'gate-1');
    assert.equal(ran.tree, board.tree, 'the runner fetched the bundle named by the job tree id');
    assert.equal(ran.fetched, true);
    assert.equal(ran.posted.length, 1);
    assert.equal(ran.posted[0].status, 0);

    assert.equal(board.steps('gate-1') - before, 1, 'the board recorded the result in one write');
    const done = jobView(board.db, 'gate-1').steps.find(step => step.name === 'shard.done');
    assert.equal(done.payload.shard, 's1');
    assert.equal(done.payload.runner, 'sandbox-1');
    assert.equal(done.payload.tree, board.tree);
    assert.equal(done.payload.digest, ran.posted[0].digest);
    const held = board.lease('gate-1');
    assert.equal(held.owner, 'sandbox-1', 'the runner took the gate job row itself by lease');
    assert.ok(held.until > Date.now(), 'the runner holds a live lease on the gate job');
    assert.equal(takeJob(board.db, 'gate-1', 'driver-b').taken, false, 'while the runner holds the gate job lease no other driver takes it');
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_id LIKE 'pull:%'").get().n, 0, 'no synthetic pull row stands in for the gate job');

    const read = await channel.fetchResult({ job: 'gate-1', shard: 's1', digest: done.payload.digest });
    assert.equal(read.state, 'done');
    assert.equal(read.status, 0);
    assert.match(read.output.toString('utf8'), /project check ok/u);
    assert.equal(await runner.runOnce(), null, 'nothing is left to take');
    assert.equal((await board.transport.probe({ host: 'sandbox-1' })).ok, true, 'asking for work renews the runner health');
  } finally { await board.close(); }
});

test('clause 2: an untrusted key is refused, the receipt cell refuses an unsigned or wrongly signed result, and the runner holds only a job token scoped to one job [C7]', async () => {
  const keys = runnerKeys(), stranger = runnerKeys();
  const trusted = [keys.publicKey];
  const board = await boardFixture('signed', trusted);
  try {
    createJob(board.db, { id: 'gate-2', kind: 'gate', item: 27 });
    await board.transport.connect({ host: 'pull-pool' }).startShard({ job: 'gate-2', shard: 's1', command: 'sh ./check.sh', tree: board.tree });

    const outsider = pullRunner({ board: board.url, runner: 'outsider', publicKey: stranger.publicKey, privateKey: stranger.privateKey, workdir: join(files.root, 'outsider') });
    await assert.rejects(outsider.register(), { code: 'PULL_RUNNER_UNTRUSTED' });
    await assert.rejects(outsider.runOnce(), { code: 'PULL_RUNNER_UNKNOWN' });
    const forged = await call(board.url, '/pull/register', JSON.stringify({ runner: 'forger', publicKey: keys.publicKey, at: Date.now(), signature: sign(null, Buffer.from(`PBREGISTER 1 forger ${Date.now()}`), stranger.key).toString('base64url') }));
    assert.equal(forged.body.code, 'PULL_SIGNATURE', 'a trusted key admits only the holder of its private half');

    const at = Date.now();
    await call(board.url, '/pull/register', JSON.stringify({ runner: 'sandbox-2', publicKey: keys.publicKey, at, signature: sign(null, Buffer.from(`PBREGISTER 1 sandbox-2 ${at}`), keys.key).toString('base64url') }));
    const nonce = 'raw-take-nonce-0001';
    const taken = await call(board.url, '/pull/take', JSON.stringify({ runner: 'sandbox-2', at, nonce, signature: sign(null, Buffer.from(`PBTAKE 1 sandbox-2 ${at} ${nonce}`), keys.key).toString('base64url') }));
    assert.equal(taken.status, 200);
    const { token, tree } = taken.body;
    const auth = { authorization: `Bearer ${token}` };
    const bytes = Buffer.from('PBRESULT 1 0 3\nok\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const before = board.steps('gate-2');

    const unsigned = await call(board.url, '/pull/result/s1', bytes, auth);
    assert.equal(unsigned.body.code, 'PULL_RESULT_INVALID');
    assert.match(unsigned.body.message, /import\.invalid: the result file is unsigned/u);
    const wrong = sign(null, Buffer.from(resultStatement({ job: 'gate-2', shard: 's1', tree, digest, command: 'sh ./check.sh' })), stranger.key).toString('base64url');
    const wrongly = await call(board.url, '/pull/result/s1', bytes, { ...auth, 'x-pullboard-signature': wrong });
    assert.match(wrongly.body.message, /does not match the registered runner key/u);
    const otherShard = sign(null, Buffer.from(resultStatement({ job: 'gate-2', shard: 's9', tree, digest, command: 'sh ./check.sh' })), keys.key).toString('base64url');
    assert.equal((await call(board.url, '/pull/result/s1', bytes, { ...auth, 'x-pullboard-signature': otherShard })).body.code, 'PULL_RESULT_INVALID', 'a signature for another shard does not carry over');
    assert.equal(board.steps('gate-2'), before, 'a refused result records nothing');

    assert.deepEqual(checkSignedResult({ bytes, publicKey: keys.publicKey, job: 'gate-2', shard: 's1', tree, command: 'sh ./check.sh' }), { valid: false, outcome: 'infra', code: 'import.invalid', reason: 'the result file is unsigned' });
    assert.equal(checkSignedResult({ bytes, signature: wrong, publicKey: keys.publicKey, job: 'gate-2', shard: 's1', tree, command: 'sh ./check.sh' }).outcome, 'infra', 'a bad signature is infra, never red');

    assert.equal((await call(board.url, '/pull/result/s1', bytes, { authorization: `Bearer ${token.slice(0, -2)}xx` })).body.code, 'PULL_TOKEN', 'a token the board did not mint is refused');
    assert.equal((await fetch(new URL(`/pull/bundle/${'0'.repeat(40)}`, board.url), { headers: auth }).then(response => response.json())).code, 'PULL_TREE', 'the token fetches only its own job bundle');
    assert.equal((await call(board.url, '/pull/result/s7', bytes, auth)).body.code, 'PULL_SHARD_UNKNOWN', 'the token posts only its own job shards');

    const good = sign(null, Buffer.from(resultStatement({ job: 'gate-2', shard: 's1', tree, digest, command: 'sh ./check.sh' })), keys.key).toString('base64url');
    const accepted = await call(board.url, '/pull/result/s1', bytes, { ...auth, 'x-pullboard-signature': good });
    assert.equal(accepted.status, 200);
    assert.equal(board.steps('gate-2') - before, 1);

    trusted.length = 0;
    const untrusted = await fetch(new URL(`/pull/bundle/${tree}`, board.url), { headers: auth }).then(response => response.json());
    assert.equal(untrusted.code, 'PULL_RUNNER_UNTRUSTED', 'a job token alone never admits a runner whose key the board stopped trusting');
  } finally { await board.close(); }
});
