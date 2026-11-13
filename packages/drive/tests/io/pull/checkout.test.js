/** A runner reuses one checkout across its jobs, reset and cleaned for each, instead of preparing a fresh one (#5812) [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/** A trunk repository with two commits: one ignoring `*.log` and tagged v0.0.1, and one adding `second.txt`; and an empty runner cache. */
function trunkRepo(t) {
  const { root: trunk } = privateFixtureFiles('pullboard-reuse-trunk-');
  const { root: cache } = privateFixtureFiles('pullboard-reuse-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, '.gitignore'), '*.log\n');
  writeFileSync(join(trunk, 'tracked.txt'), 'original\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'one');
  const first = sh('rev-parse', 'HEAD');
  sh('tag', '-a', 'v0.0.1', '-m', 'release');
  writeFileSync(join(trunk, 'second.txt'), 'two\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'two');
  return { cache, trunk, first, second: sh('rev-parse', 'HEAD') };
}

/**
 * A board stand-in that hands out the given jobs in order, records when each claim was answered, and keeps receipts.
 * Why a stand-in: the clauses time the runner's own steps between claim and command, which no board shapes.
 */
function fakeBoard(trunk, jobs) {
  const claimedAt = [], receipts = [];
  let next = 0;
  const reply = document => ({ status: 200, json: async () => document });
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      const job = jobs[next++];
      claimedAt.push(Date.now());
      return reply({ trunk, claim: job ? { job: job.id, attempt: 1, token: `t-${job.id}`, candidate: job.commit, base: job.commit, run: job.run } : null });
    }
    if (call.action === 'receipt') receipts.push(call.receipt);
    return reply({ ok: true, renewed: true });
  };
  return { fetchImpl, claimedAt, receipts };
}

/** A node argv that prints its cwd and start time, writes `stamp`, then prints the folder's files with `git status`. */
function job(stamp) {
  const script = `const fs=require('node:fs');const cp=require('node:child_process');console.log('START '+Date.now());console.log('CWD '+process.cwd());`
    + `console.log('FILES '+JSON.stringify(fs.readdirSync('.').filter(f=>f!=='.git').sort()));`
    + `console.log('RELEASE '+cp.execFileSync('git',['rev-parse','v0.0.1^{commit}'],{encoding:'utf8'}).trim());`
    + `console.log('TRUNK '+cp.execFileSync('git',['config','pullboard.trunk'],{encoding:'utf8'}).trim());`
    + `console.log('STATUS '+JSON.stringify(cp.execFileSync('git',['status','--porcelain','--ignored'],{encoding:'utf8'})));`
    + (stamp ? `fs.writeFileSync('tracked.txt','dirty\\n');fs.writeFileSync('left.txt','x');fs.writeFileSync('run.log','x');fs.mkdirSync('out/deep',{recursive:true});fs.writeFileSync('out/deep/a','x');` : '');
  return ['node', '-e', script];
}

/** The value printed after `key ` in a receipt's output tail. */
function field(receipt, key) {
  const line = receipt.tail.split('\n').find(row => row.startsWith(`${key} `));
  return line ? line.slice(key.length + 1) : null;
}

/** Serve the given jobs through one runner until the board has none left. */
async function serveAll(t, jobs) {
  const { cache, trunk, first, second } = trunkRepo(t);
  const board = fakeBoard(trunk, jobs({ first, second }));
  const stop = new AbortController();
  const sleep = async () => { stop.abort(); };
  await serveRunner({ board: BOARD, runner: 'r-reuse', capabilities: [], cache, jobs: 1, signal: stop.signal, fetchImpl: board.fetchImpl, sleep, timing: { idleMs: 1 } });
  return { ...board, first, second };
}

test('clause 1: a second job on the same runner reuses the checkout and starts its command in under 3 s after claim [P7]', { timeout: 60_000 }, // budget: two local git checkouts and two node children.
  async t => {
    const { receipts, claimedAt } = await serveAll(t, ({ first, second }) => [{ id: 'j1', commit: first, run: job(true) }, { id: 'j2', commit: second, run: job(false) }]);
    assert.equal(receipts.length, 2, JSON.stringify(receipts));
    assert.deepEqual(receipts.map(receipt => receipt.status), [0, 0], receipts.map(receipt => receipt.tail).join('\n'));
    assert.equal(field(receipts[1], 'CWD'), field(receipts[0], 'CWD'), 'the second job runs in the first job\'s folder');
    const waited = Number(field(receipts[1], 'START')) - claimedAt[1];
    assert.ok(waited < 3_000, `the second job's command started ${waited} ms after its claim`);
    assert.equal(field(receipts[1], 'TRUNK'), 'refs/heads/main', 'a reused checkout still names its trunk');
  });

test('clause 2: a reused checkout carries no file from the previous job [P7]', { timeout: 60_000 }, // budget: as clause 1.
  async t => {
    const { receipts } = await serveAll(t, ({ first, second }) => [{ id: 'j1', commit: second, run: job(true) }, { id: 'j2', commit: first, run: job(false) }]);
    assert.equal(receipts.length, 2, JSON.stringify(receipts));
    assert.equal(field(receipts[1], 'CWD'), field(receipts[0], 'CWD'));
    assert.deepEqual(JSON.parse(field(receipts[1], 'FILES')), ['.gitignore', 'tracked.txt'], 'only the second commit\'s files, none the first job wrote or its commit had');
    assert.equal(JSON.parse(field(receipts[1], 'STATUS')), '', 'no tracked change, untracked or ignored file survives');
    assert.equal(readFileSync(join(field(receipts[1], 'CWD'), 'tracked.txt'), 'utf8'), 'original\n');
  });

test('a fresh and a reused checkout both resolve the trunk\'s release tags, which pulled proofs unpack old releases from [P7]', { timeout: 60_000 }, // budget: as clause 1.
  async t => {
    const { receipts, first } = await serveAll(t, ({ first, second }) => [{ id: 'j1', commit: second, run: job(false) }, { id: 'j2', commit: first, run: job(false) }]);
    assert.equal(receipts.length, 2, JSON.stringify(receipts));
    assert.deepEqual(receipts.map(receipt => field(receipt, 'RELEASE')), [first, first], receipts.map(receipt => receipt.tail).join('\n'));
  });

/** One serve with no runner name, as `runner serve` starts it, over the shared cache, until the board has no job left. */
async function serveUnnamed(cache, trunk, jobs) {
  const board = fakeBoard(trunk, jobs);
  const stop = new AbortController();
  await serveRunner({ board: BOARD, capabilities: [], cache, jobs: 1, signal: stop.signal, fetchImpl: board.fetchImpl, sleep: async () => { stop.abort(); }, timing: { idleMs: 1 } });
  return board.receipts;
}

test('after a runner serve restart, a job slot reuses the same checkout folder, keeping its warm files [P7]', { timeout: 60_000 }, // budget: as clause 1.
  async t => {
    const { cache, trunk, first, second } = trunkRepo(t);
    const before = await serveUnnamed(cache, trunk, [{ id: 'j1', commit: first, run: job(true) }]);
    // A file git ignores is what a warm test-action cache is; a restart that kept the folder would still reset it, so the folder is the proof.
    const after = await serveUnnamed(cache, trunk, [{ id: 'j2', commit: second, run: job(false) }]);
    assert.deepEqual([before.length, after.length], [1, 1]);
    const folder = field(before[0], 'CWD');
    assert.equal(field(after[0], 'CWD'), folder, 'the restarted serve runs in the first serve\'s slot folder');
    assert.match(folder, /[\\/]work[\\/]runner-[^\\/]+-0$/u);
    assert.ok(folder.endsWith(`runner-${hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40)}-0`), 'no per-restart hash in the folder name');
    assert.ok(existsSync(join(folder, 'second.txt')), 'the folder was adopted and reset to the new commit');
    assert.deepEqual(slotLocks(cache), [], 'a finished serve gives its slot prefix back');
  });

test('a serve beside another live serve on the host takes its own slot folders and leaves the holder\'s lock [P7]', { timeout: 60_000 }, // budget: as clause 1.
  async t => {
    const { cache, trunk, first } = trunkRepo(t);
    const host = hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'runner';
    mkdirSync(join(cache, 'slots'), { recursive: true });
    const lock = join(cache, 'slots', `runner-${host}.pid`);
    writeFileSync(lock, `${process.ppid}:held`);
    const [receipt] = await serveUnnamed(cache, trunk, [{ id: 'j1', commit: first, run: job(false) }]);
    assert.match(field(receipt, 'CWD'), new RegExp(`runner-${host.replace(/[.]/gu, '\\.')}-[0-9a-f]{6}-0$`, 'u'), 'a held host prefix is not shared');
    assert.equal(readFileSync(lock, 'utf8'), `${process.ppid}:held`, 'the holder\'s lock is untouched');
  });

/** The slot-lock files left in a cache. */
function slotLocks(cache) {
  try { return readdirSync(join(cache, 'slots')); } catch { return []; }
}
