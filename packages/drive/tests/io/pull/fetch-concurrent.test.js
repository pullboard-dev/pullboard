/** @pullboard-test-input source-cell packages/drive */
/** With runners.fetchConcurrent on, claims for different missing commits fetch together, up to 4 at once; off, they fetch one at a time [#9884,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkoutCandidate } from '../../../index.js';
import { countingTurns } from '../../../index.js';
import { runTestGit } from '../../fixtures/git.js';
import { testGit } from '../../fixtures/git.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';

const CLAIMS = 8;
const HOLDS = 20;

/** A trunk repository with eight commits on eight branches, and an empty runner cache folder. */
async function trunkWithEightCommits(t) {
  const trunk = temporaryDirectory('pullboard-fetchconc-trunk-');
  const cache = temporaryDirectory('pullboard-fetchconc-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = async (...args) => (await runTestGit(trunk, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args])).stdout;
  await sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'tracked.txt'), 'base\n');
  await sh('add', '.');
  await sh('commit', '-q', '-m', 'base');
  const commits = [];
  for (let n = 0; n < CLAIMS; n += 1) {
    await sh('checkout', '-q', '-b', `job-${n}`, 'main');
    writeFileSync(join(trunk, 'tracked.txt'), `job ${n}\n`);
    await sh('commit', '-q', '-a', '-m', `job ${n}`);
    commits.push(await sh('rev-parse', 'HEAD'));
  }
  return { trunk, cache, commits };
}

/** Git whose trunk fetch is held open by real git commands, up to 20 of them or until 4 fetches are open, counting how many run at once. */
function slowFetches() {
  const seen = { active: 0, most: 0 };
  const git = { run: runTestGit, fetchTrunk: async (store, trunk, refs) => {
    seen.active += 1; seen.most = Math.max(seen.most, seen.active);
    for (let hold = 0; hold < HOLDS && seen.active < 4; hold += 1) await runTestGit(store, ['rev-parse', '--git-dir']);
    try { return await testGit.fetchTrunk(store, trunk, refs); } finally { seen.active -= 1; }
  } };
  return { seen, git };
}

/** The serial turn serveRunner uses for the shared object cache. */
function serialTurns() {
  let lock = Promise.resolve();
  return work => { const turn = lock.then(work, work); lock = turn.catch(() => {}); return turn; };
}

/** Run one claim per commit at once, as eight slots would. */
async function eightClaims({ cache, trunk, commits }, git, options) {
  return Promise.all(commits.map((commit, slot) => checkoutCandidate(cache, trunk, commit, `slot-${slot}`, [], { git, ...options })));
}

test('clause 1: with runners.fetchConcurrent on, 8 claims for 8 different missing commits show at least 2 fetches at once and none beyond 4 [#9884,C7]', async t => {
  const world = await trunkWithEightCommits(t);
  const { seen, git } = slowFetches();
  const results = await eightClaims(world, git, { exclusive: serialTurns(), fetchTurn: countingTurns(4) });
  for (const result of results) assert.equal(result.ok, true, result.reason);
  assert.ok(seen.most >= 2, `fetches overlapped: most at once ${seen.most}`);
  assert.ok(seen.most <= 4, `no more than 4 at once: most at once ${seen.most}`);
});

test('clause 2: with runners.fetchConcurrent on, each of the 8 claims reports a fetchMs under 1000 ms [#9884,C7]', async t => {
  const world = await trunkWithEightCommits(t);
  const { git } = slowFetches();
  const results = await eightClaims(world, git, { exclusive: serialTurns(), fetchTurn: countingTurns(4) });
  for (const result of results) {
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.phases.fetchMs < 1000, `fetchMs ${result.phases.fetchMs}`);
  }
});

test('clause 3: with runners.fetchConcurrent off, the same 8 claims fetch one at a time [#9884,C7]', async t => {
  const world = await trunkWithEightCommits(t);
  const { seen, git } = slowFetches();
  const results = await eightClaims(world, git, { exclusive: serialTurns() });
  for (const result of results) assert.equal(result.ok, true, result.reason);
  assert.equal(seen.most, 1, `one fetch at a time: most at once ${seen.most}`);
});
