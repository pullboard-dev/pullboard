/** @pullboard-test-input source-cell landing */
/** A land job whose request carries a shardProof run renews its lease around its synchronous fetches and ends in a receipt, so no second runner re-claims it [C7,#9250]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runLandingJob } from '../../../index.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

const FILES = ['test/a.test.js'];
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A bare trunk remote with one accepted item, a clean runner workdir, and a payload that carries the shardProof gate as #9180's did. */
function landing(t) {
  const repo = cellRepo(t, { real: true });
  const bare = privateFixtureFiles('pullboard-landshardjob-remote-');
  const work = privateFixtureFiles('pullboard-landshardjob-work-');
  t.after(() => { rmSync(bare.root, { recursive: true, force: true }); rmSync(work.root, { recursive: true, force: true }); });
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env: ENV });
  runFixtureSetupGit(['init', '-q', '--bare', '-b', 'main', bare.root], { env: ENV });
  const expect = git('rev-parse', 'HEAD');
  git('push', '-q', bare.root, 'main');
  for (const file of FILES) repo.put(file, 'export {};\n');
  const commit = repo.commitAll();
  git('push', '-q', bare.root, `${commit}:refs/heads/item-1`);
  const payload = { shape: 2, remote: bare.root, trunk: 'refs/heads/main', expect, items: [{ id: 1, commit, ref: 'refs/heads/item-1' }],
    proof: { runner: 'true', files: FILES, ledger: null }, shardProof: { run: ['node', '-e', 'x'], entry: 'gate.js' } };
  return { payload, workdir: work.root, at: ref => runFixtureSetupGit(['rev-parse', '--verify', '--quiet', ref], { cwd: bare.root, env: ENV }), expect };
}

test('clause 1: a shardProof land job renews its lease before each fetch and ends in one landed receipt [test] [C7,#9250]', async t => {
  const { payload, workdir } = landing(t);
  let renewals = 0;
  const receipt = await runLandingJob(payload, { workdir, renew: () => { renewals += 1; return true; } });
  assert.equal(receipt.outcome, 'landed', receipt.detail);
  assert.ok(renewals >= 3, `renewed before the item fetch, the trunk fetch and the check (saw ${renewals})`);
});

test('clause 1: a shardProof land job whose lease moved while it fetched stops with lease-lost and leaves trunk where it was [test] [C7,#9250]', async t => {
  const { payload, workdir, at, expect } = landing(t);
  const receipt = await runLandingJob(payload, { workdir, renew: () => false });
  assert.equal(receipt.outcome, 'lease-lost');
  assert.equal(at('refs/heads/main'), expect, 'trunk did not move');
});
