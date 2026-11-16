/** A runner whose prune walk stalls its event loop loses every held lease with no receipt; with runners.yieldWhilePruning on the job ends in a receipt (#9025) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../../packages/drive/index.js';
import { pruneRunnerStores } from '../../../../packages/drive/index.js';
import { pruneRunnerStoresYielding } from '../../../../packages/drive/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
// The census of 16 Nov: a lease the board grants lapses unless renewed, and a stalled loop renews nothing.
const LEASE_MS = 150;
const STALL_MS = 400;
// The job ends once the board has seen this many renewals, or one finds the lease taken.
const RENEWALS_ENOUGH = 5;

/** A board stand-in with one land job and a real-time lease: a renewal after the lease lapsed finds another runner holding the job. */
function leasedBoard(stop) {
  const board = { receipts: [], releases: [], renewals: 0, stolen: false, until: 0 };
  board.enough = new Promise(resolve => { board.end = resolve; });
  board.fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    const moved = () => ({ status: 409, json: async () => ({ error: { code: 'JOB_LEASE_MOVED', message: 'another runner holds the job' } }) });
    const ok = reply => ({ status: 200, json: async () => reply });
    if (call.action === 'claim') {
      if (board.until) return ok({ claim: null });
      board.until = Date.now() + LEASE_MS;
      return ok({ trunk: 'unused', claim: { job: 'test:census', kind: 'land', needs: [], run: [], payload: {}, candidate: null, base: null, attempt: 1, token: 'r:1' } });
    }
    if (call.action === 'renew') {
      board.renewals += 1;
      if (Date.now() > board.until) board.stolen = true;
      if (board.stolen || board.renewals >= RENEWALS_ENOUGH) board.end();
      if (board.stolen) return moved();
      board.until = Date.now() + LEASE_MS;
      return ok({ renewed: true });
    }
    if (call.action === 'receipt' || call.action === 'release') {
      (call.action === 'receipt' ? board.receipts : board.releases).push(call);
      stop.abort();
      return board.stolen ? moved() : ok({ recorded: true });
    }
    return ok({ recorded: true });
  };
  return board;
}

/** Busy-wait on the event loop, as the synchronous walk of a huge cache does. */
function block(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* the loop is stalled */ } }

/** One land job held until the board has seen enough renewals while a prune of the given kind runs on every pass of the claim loop. */
async function serveWithPrune(t, { yields, prune, pruneYielding }) {
  const { root } = privateFixtureFiles('pullboard-lease-prune-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stop = new AbortController();
  const board = leasedBoard(stop);
  const handlers = { land: async () => { await board.enough; return { outcome: 'landed' }; } };
  const served = await serveRunner({ git: {}, board: BOARD, runner: 'r-prune', capabilities: [], cache: join(root, 'cache'), jobs: 2, cores: 2, signal: stop.signal, fetchImpl: board.fetchImpl,
    handlers, trunkPack: async () => null, timing: { idleMs: 5, renewMs: 30, renewRetryMs: 10, pruneMs: 1 }, pruneYields: yields, prune, pruneYielding });
  return { board, served };
}

test('clause 1: the prune walk that held the loop for two minutes on anvil and mill (renewals silent from the last post to "renewal still failing past the lease") is the cause; a stalled loop stops renewals (#9025) [C7]', async t => {
  const { board } = await serveWithPrune(t, { yields: false, prune: () => { block(STALL_MS); return { removed: [] }; }, pruneYielding: async () => ({ removed: [] }) });
  assert.ok(board.stolen, 'the first renewal after the stall found the lease lapsed');
});

test('clause 2: with the prune blocking the serve, the job ends with no receipt and no released step, as on 16 Nov, and the setting-off path is unchanged (#9025) [C7]', async t => {
  const { board, served } = await serveWithPrune(t, { yields: false, prune: () => { block(STALL_MS); return { removed: [] }; }, pruneYielding: async () => ({ removed: [] }) });
  assert.equal(served.jobs[0].outcome, 'lost');
  assert.equal(board.releases.length, 0, 'no released step');
  assert.equal(board.receipts.filter(call => !board.stolen).length, 0, 'no receipt the board accepted');
});

test('clause 2: with runners.yieldWhilePruning on, the same stall in slices keeps the lease and the job ends in a receipt (#9025) [C7]', async t => {
  const slow = async () => { const end = Date.now() + STALL_MS; while (Date.now() < end) await new Promise(resolve => setImmediate(resolve)); return { removed: [] }; };
  const { board, served } = await serveWithPrune(t, { yields: true, prune: () => { throw new Error('the blocking prune must not run'); }, pruneYielding: slow });
  assert.equal(board.stolen, false, 'every renewal found the lease held');
  assert.equal(served.jobs[0].outcome, 'posted');
  assert.equal(board.receipts.length, 1);
});

test('clause 3: the yielding prune removes what the blocking one removes, and lets timers run while it walks a large cache (#9025) [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-lease-prune-walk-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'cache');
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  for (const name of ['old-a', 'old-b']) {
    const folder = join(cache, 'env', name);
    for (let dir = 0; dir < 30; dir++) { mkdirSync(join(folder, `d${dir}`), { recursive: true }); for (let file = 0; file < 20; file++) writeFileSync(join(folder, `d${dir}`, `f${file}`), 'x'); }
    for (let dir = 0; dir < 30; dir++) utimesSync(join(folder, `d${dir}`), old, old);
    utimesSync(folder, old, old);
    for (let dir = 0; dir < 30; dir++) for (let file = 0; file < 20; file++) utimesSync(join(folder, `d${dir}`, `f${file}`), old, old);
  }
  mkdirSync(join(cache, 'env', 'running'), { recursive: true });
  const options = { root, cache, live: new Set(['running']), tmp: join(root, 'tmp') };
  let ticks = 0, finished = false;
  const walking = pruneRunnerStoresYielding({ ...options }, { sliceMs: 0 }).finally(() => { finished = true; });
  while (!finished) { await new Promise(resolve => setImmediate(resolve)); ticks += 1; }
  const yielded = await walking;
  assert.deepEqual(yielded.removed.map(path => path.split('/').at(-1)).sort(), ['old-a', 'old-b']);
  assert.ok(ticks > 1, 'the event loop ran during the walk');
  // The blocking prune finds nothing more to remove, since the yielding one took them: the same two, once, from a fresh tree.
  mkdirSync(join(cache, 'env', 'old-c', 'd'), { recursive: true });
  utimesSync(join(cache, 'env', 'old-c', 'd'), old, old); utimesSync(join(cache, 'env', 'old-c'), old, old);
  assert.deepEqual(pruneRunnerStores({ ...options }).removed.map(path => path.split('/').at(-1)), ['old-c']);
});
