/** @pullboard-test-input source-cell landing */
/** A sharded land proof reports the files its shards reused from the gate's results, not 0 reused [C7,#9515]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runLandingJob } from '../../../index.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

const JOB = 'land:1:abcd';
const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
const GATE = { run: ['node', '-e', 'x'], entry: 'gate.js' };
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const HASH = 'f'.repeat(64);

/** A trunk remote with one accepted item adding the proof's files, and a clean workdir. */
function landing(t, extra = {}) {
  const repo = cellRepo(t, { real: true });
  const bare = privateFixtureFiles('pullboard-landreuse-remote-');
  const work = privateFixtureFiles('pullboard-landreuse-work-');
  t.after(() => { rmSync(bare.root, { recursive: true, force: true }); rmSync(work.root, { recursive: true, force: true }); });
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env: ENV });
  runFixtureSetupGit(['init', '-q', '--bare', '-b', 'main', bare.root], { env: ENV });
  const expect = git('rev-parse', 'HEAD');
  git('push', '-q', bare.root, 'main');
  for (const file of FILES) repo.put(file, 'export {};\n');
  const commit = repo.commitAll();
  git('push', '-q', bare.root, `${commit}:refs/heads/item-1`);
  const payload = { shape: 2, remote: bare.root, trunk: 'refs/heads/main', expect, items: [{ id: 1, commit, ref: 'refs/heads/item-1' }],
    proof: { runner: 'true', files: FILES, ledger: null }, shardProof: GATE, ...extra };
  return { payload, workdir: work.root, commit };
}

/** A shard receipt whose proof tail prints the test cache summary and one ledger-hit line per reused file. */
const posted = (reused, ran, files) => ({ runner: 'r-2', receipt: { version: 1, status: 0, gate: { green: true, phases: [{ role: 'proof', status: 0,
  tail: [...files.map(file => `# reused ${HASH} from ledger (${file})`), `# test cache: ${reused + ran} files, ${reused} reused, ${ran} ran; top missed inputs: none`, '# pass 2'].join('\n') }] } } });

/** The shards option: two shards that post at once. */
function shardsOf(offered, receipts) {
  const ids = ['a', 'b'].map(n => `${JOB}:shard:${n}`);
  return { job: JOB, cores: 1, pollMs: 0, wait: async () => {},
    offer: request => { offered.push(request); return { sharded: true, shards: ids }; },
    receipts: list => list.map(job => ({ job, posted: receipts[ids.indexOf(job)] })) };
}

test('clause 1: with reuseGateReceipts on the land receipt lists the files its shards reused and counts them, and asks the board to head the hit lists with the items\' commits [C7,#9515]', async t => {
  const { payload, workdir, commit } = landing(t, { reuseGateReceipts: true });
  const offered = [];
  const receipt = await runLandingJob(payload, { workdir, shards: shardsOf(offered, [posted(1, 1, [FILES[0]]), posted(1, 0, [FILES[2]])]) });
  assert.equal(receipt.outcome, 'landed', receipt.detail);
  assert.equal(offered[0].reuse, true);
  assert.deepEqual([receipt.proof.files, receipt.proof.reused, receipt.proof.ran], [3, 2, 1]);
  assert.deepEqual(receipt.proof.reusedFiles, [FILES[0], FILES[2]]);
  assert.ok(commit);
});

test('clause 1: with reuseGateReceipts off the count is still what the shards reused, with no file account and no ask [C7,#9515]', async t => {
  const { payload, workdir } = landing(t);
  const offered = [];
  const receipt = await runLandingJob(payload, { workdir, shards: shardsOf(offered, [posted(1, 1, [FILES[0]]), posted(1, 0, [FILES[2]])]) });
  assert.equal(receipt.outcome, 'landed', receipt.detail);
  assert.equal('reuse' in offered[0], false);
  assert.deepEqual([receipt.proof.reused, receipt.proof.ran], [2, 1]);
  assert.equal('reusedFiles' in receipt.proof, false);
});
