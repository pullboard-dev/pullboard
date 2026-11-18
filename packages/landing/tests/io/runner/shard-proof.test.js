/** @pullboard-test-input source-cell landing */
/** A land job with landing.shardProof on pins its merged commit, waits on its proof's shards and pushes trunk only when every one is green [C7,#7818,#8197]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runLandingJob } from '../../../index.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

const JOB = 'land:1:abcd';
// The job id's colons are not valid in a ref name, so the ref spells them as hyphens.
const REF = 'refs/pullboard/landing/land-1-abcd';
const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js' };
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A bare trunk remote holding main and one accepted item that adds the proof's three test files, with a clean workdir for the runner. */
function landing(t) {
  const repo = cellRepo(t, { real: true });
  const bare = privateFixtureFiles('pullboard-landshard-remote-');
  const work = privateFixtureFiles('pullboard-landshard-work-');
  t.after(() => { rmSync(bare.root, { recursive: true, force: true }); rmSync(work.root, { recursive: true, force: true }); });
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env: ENV });
  const remote = bare.root;
  runFixtureSetupGit(['init', '-q', '--bare', '-b', 'main', remote], { env: ENV });
  const expect = git('rev-parse', 'HEAD');
  git('push', '-q', remote, 'main');
  for (const file of FILES) repo.put(file, 'export {};\n');
  const commit = repo.commitAll();
  git('push', '-q', remote, `${commit}:refs/heads/item-1`);
  const at = ref => runFixtureSetupGit(['rev-parse', '--verify', '--quiet', ref], { cwd: remote, env: ENV });
  const payload = { shape: 2, remote, trunk: 'refs/heads/main', expect, items: [{ id: 1, commit, ref: 'refs/heads/item-1' }],
    proof: { runner: 'true', files: FILES, ledger: null }, shardProof: GATE };
  return { payload, workdir: work.root, at, expect, remote, commit };
}

/** The green receipt a gate-shard job posts, and the red one naming a failing case. */
const green = { runner: 'r-2', receipt: { version: 1, status: 0, gate: { green: true, phases: [{ role: 'proof', status: 0 }] } } };
const red = { runner: 'r-3', receipt: { version: 1, status: 1, gate: { green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'test/b.test.js', name: 'adds up' }], tail: 'not ok 1 - adds up' }] } } };

/** The shards option a takeLandingJob would build, with the board's two answers scripted: `posts` is each poll's receipts by shard id. */
function shardsOf(offered, posts, { cores = 1, wait = async () => {} } = {}) {
  let poll = 0;
  return { job: JOB, cores, pollMs: 0, wait,
    offer: request => { offered.push(request); return { sharded: true, shards: ['a', 'b'].map(n => `${JOB}:shard:${n}`) }; },
    receipts: ids => { const now = posts[Math.min(poll++, posts.length - 1)]; return ids.map(job => ({ job, posted: now[job] ?? null })); } };
}

test('landing.shard-proof.runlandingjob-pushes-the-merged-commit-to: clause 1: runLandingJob pushes the merged commit to refs/pullboard/landing/<job> before the proof is offered [test] [C7,#7818]', async t => {
  const { payload, workdir, at, expect } = landing(t);
  const offered = [], seen = [];
  const shards = shardsOf(offered, [{ [`${JOB}:shard:a`]: green, [`${JOB}:shard:b`]: green }]);
  const offer = shards.offer;
  shards.offer = request => { seen.push(at(REF)); return offer(request); };
  const receipt = await runLandingJob(payload, { workdir, shards });
  assert.equal(receipt.outcome, 'landed', receipt.detail);
  assert.equal(seen.length, 1, 'the proof is offered once');
  assert.equal(seen[0], offered[0].merged, 'the ref held the merged commit when the shards were offered');
  assert.notEqual(offered[0].merged, payload.items[0].commit, 'the merged commit is the merge, not the item');
  assert.equal(offered[0].ref, REF, 'the shards name the ref their runners fetch');
  assert.deepEqual(offered[0].plan, { runner: 'true', files: FILES, cores: 1 });
  assert.deepEqual(offered[0].gate, { ...GATE, commits: [expect] });
});

test('landing.shard-proof.a-proof-of-more-files-than: clause 2: a proof of more files than one runner\'s cores lands only after every shard posts green, and never before [test] [C7,#7818]', async t => {
  const { payload, workdir, at, expect } = landing(t);
  const offered = [], trunkWhileWaiting = [];
  const a = `${JOB}:shard:a`, b = `${JOB}:shard:b`;
  const shards = shardsOf(offered, [{}, { [a]: green }, { [a]: green, [b]: green }], { wait: async () => { trunkWhileWaiting.push(at('refs/heads/main')); } });
  const receipt = await runLandingJob(payload, { workdir, shards });
  assert.equal(receipt.outcome, 'landed', receipt.detail);
  assert.deepEqual(trunkWhileWaiting, [expect, expect], 'trunk stays put while a shard has not posted');
  assert.equal(at('refs/heads/main'), receipt.trunk, 'trunk moves once all are green');
  assert.deepEqual(receipt.proof, { files: 3, reused: 0, ran: 3, shards: 2 });
});

test('landing.shard-proof.a-red-shard-keeps-trunk-where: clause 3: a red shard keeps trunk where it was and names its failing file and case, as the single-runner proof does [test] [C7,#7818]', async t => {
  const { payload, workdir, at, expect } = landing(t);
  const shards = shardsOf([], [{ [`${JOB}:shard:a`]: green, [`${JOB}:shard:b`]: red }]);
  const receipt = await runLandingJob(payload, { workdir, shards });
  assert.equal(receipt.outcome, 'red');
  assert.equal(at('refs/heads/main'), expect, 'a red shard lands nothing');
  const detail = receipt.returned[0].detail;
  assert.match(detail, /red in test\/b\.test\.js/u);
  assert.match(detail, /failing cases:\nnot ok - adds up/u);
  assert.match(detail, new RegExp(`shard ${JOB}:shard:b`, 'u'));
});

test('landing.shard-proof.with-landing-shardproof-off-or-a: clause 2: with landing.shardProof off, or a proof within one runner\'s cores, the proof runs on the one runner and offers nothing [test] [C7,#7818]', async t => {
  for (const [name, change, cores] of [['off', { shardProof: undefined }, 1], ['within cores', {}, 3]]) {
    const { payload, workdir } = landing(t);
    const offered = [];
    const receipt = await runLandingJob({ ...payload, ...change }, { workdir, shards: shardsOf(offered, [{}], { cores }) });
    assert.equal(receipt.outcome, 'landed', `${name}: ${receipt.detail}`);
    assert.deepEqual(offered, [], `${name}: no shard is offered`);
    assert.deepEqual(receipt.proof, { files: 3, reused: 0, ran: 3 }, `${name}: the single-runner proof ran`);
  }
});

test('landing.shard-proof.a-land-job-whose-proof-names: clause 1: a land job whose proof names more than one shard offers every shard as a shard job and lands only when every shard is green [test] [C7,#7818]', async t => {
  const { payload, workdir, at, expect } = landing(t);
  const offered = [], trunkWhileWaiting = [];
  const [a, b] = [`${JOB}:shard:a`, `${JOB}:shard:b`];
  const shards = shardsOf(offered, [{ [a]: green }, { [a]: green, [b]: green }], { wait: async () => { trunkWhileWaiting.push(at('refs/heads/main')); } });
  const receipt = await runLandingJob(payload, { workdir, shards });
  assert.equal(offered.length, 1, 'the whole proof is offered once, as shard jobs');
  assert.equal(receipt.proof.shards, 2, 'both shards are the proof');
  assert.deepEqual(trunkWhileWaiting, [expect], 'trunk stays put while one shard is green and the other has not posted');
  assert.equal(receipt.outcome, 'landed', receipt.detail);
  assert.equal(at('refs/heads/main'), receipt.trunk, 'trunk moves once every shard is green');
});
