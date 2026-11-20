/** @pullboard-test-input packages/api/src/io/stale.js */
/** The coordinator ends the offered shards of gates whose candidate lacks a named main commit, in one indexed pass, and the gate settles red to its builder [C7,#12166]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { endStaleShardOffers } from '../../../index.js';
import { jobViews } from '../../../index.js';
import { offerJob } from '../../../index.js';

const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'];
const PROOF = `node --test ${FILES.map(file => `'./${file}'`).join(' ')}`;
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
const UNREADABLE = 'f'.repeat(40);
const NEXT = 'merge main and submit again';

/**
 * A claimed item whose gate job passed its check at the repo's first commit and left its proof to four offered shards,
 * then a main commit the candidate lacks; with `claim`, a runner first takes one of those shards. Beside it: two shards of a gate built on that main commit, a release shard at
 * the old commit, and a shard whose candidate git cannot read.
 */
function staleGate(t, { claim = false } = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit, tree = headTree(repo.root);
  const job = `gate:${item.item_id}:stale`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  assert.equal(lease?.job, job, 'the runner pulls the offered gate');
  const gate = { version: 1, source: head, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: PROOF },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3 });
  assert.equal(posted.applied.outcome, 'sharded', JSON.stringify(posted.applied));
  const claimed = claim ? claimJob(board.db, { runner: 'r-shard', capabilities: [], now: 4 })?.job ?? null : null;
  if (claim) assert.ok(posted.applied.shards.includes(claimed), 'a runner holds one shard of the gate');
  repo.put('web/fix.txt', 'the main fix\n');
  const fix = repo.commitAll();
  const current = ['gate:900:current:shard:1', 'gate:900:current:shard:2'];
  for (const id of current) offerJob(board.db, { id, kind: 'gate-shard', needs: [], item: 900, candidate: fix, base: fix, now: 4 });
  const release = 'release:00000000-0000-0000-0000-000000000000:shard:1';
  offerJob(board.db, { id: release, kind: 'gate-shard', needs: [], candidate: head, base: head, now: 4 });
  const unreadable = 'gate:901:lost:shard:1';
  offerJob(board.db, { id: unreadable, kind: 'gate-shard', needs: [], item: 901, candidate: UNREADABLE, base: UNREADABLE, now: 4 });
  return { repo, board, item, seat, job, fix, shards: posted.applied.shards, claimed, current, release, unreadable };
}

/** The step of each named job. */
const steps = (board, ids) => jobViews(board.db, ids).map(view => view.step);

/** The withdrawn step's detail on each named job. */
const details = (board, ids) => jobViews(board.db, ids).map(view => view.steps.find(step => step.name === 'withdrawn')?.payload?.detail ?? null);

test('api.io-stale-shard-offers.ends-stale-offered: clause 1: the offered shards of a gate whose candidate lacks the main commit end as withdrawn naming it and the next step, while a claimed shard, a current gate, a release shard and an unreadable candidate stay [C7,#12166]', t => {
  const { repo, board, item, job, fix, shards, claimed, current, release, unreadable } = staleGate(t, { claim: true });
  const offered = shards.filter(id => id !== claimed);
  const result = endStaleShardOffers(board.db, { root: repo.root, before: fix.slice(0, 12), now: 6 });
  assert.equal(result.before, fix, 'the named commit resolves to its full sha');
  assert.deepEqual(result.gates, [{ gate: job, item: item.item_id, candidate: repo.commit, shards: offered }]);
  assert.equal(result.ended, offered.length);
  assert.deepEqual(result.unknown, [UNREADABLE], 'a candidate git cannot read is named, not ended');
  assert.deepEqual(steps(board, offered), offered.map(() => 'done'));
  for (const detail of details(board, offered)) {
    assert.match(detail, new RegExp(fix.slice(0, 12), 'u'), 'the detail names the missing commit');
    assert.match(detail, new RegExp(NEXT, 'u'), 'the detail names the next step');
  }
  assert.deepEqual(steps(board, [claimed]), ['claimed'], 'the claimed shard runs on');
  assert.deepEqual(steps(board, [...current, release, unreadable]), ['offered', 'offered', 'offered', 'offered'], 'the current gate, the release shard and the unreadable candidate stay offered');
  assert.equal(endStaleShardOffers(board.db, { root: repo.root, before: fix, now: 7 }).ended, 0, 'a second call ends nothing more');
});

test('api.io-stale-shard-offers.dry-run-ends-nothing: clause 1: with dryRun the same gate and shards are returned and every shard stays offered [C7,#12166]', t => {
  const { repo, board, item, job, fix, shards } = staleGate(t);
  const result = endStaleShardOffers(board.db, { root: repo.root, before: fix, dryRun: true });
  assert.deepEqual(result.gates, [{ gate: job, item: item.item_id, candidate: repo.commit, shards }]);
  assert.equal(result.ended, 0);
  assert.deepEqual(steps(board, shards), shards.map(() => 'offered'));
});

test('api.io-stale-shard-offers.unknown-commits: clause 1: a before git cannot resolve refuses STALE_BEFORE_UNKNOWN and ends nothing [C7,#12166]', t => {
  const { repo, board, shards, current, release, unreadable } = staleGate(t);
  const all = [...shards, ...current, release, unreadable];
  assert.throws(() => endStaleShardOffers(board.db, { root: repo.root, before: 'e'.repeat(40) }), error => error.code === 'STALE_BEFORE_UNKNOWN');
  assert.throws(() => endStaleShardOffers(board.db, { root: repo.root, before: '' }), error => error.code === 'STALE_BEFORE_UNKNOWN');
  assert.deepEqual(steps(board, all), all.map(() => 'offered'), 'nothing ended');
});

test('api.io-stale-shard-offers.one-indexed-pass: clause 2: one call reads the job table once through an index on job_step, and runs one ancestry check per distinct candidate, not per shard [C7,#12166]', t => {
  const { repo, board, fix, shards, current, unreadable } = staleGate(t);
  const prepared = [];
  const db = new Proxy(board.db, { get(target, key) {
    if (key === 'prepare') return sql => { prepared.push(sql); return target.prepare(sql); };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const trace = join(repo.root, '.git', 'stale-trace.log');
  const saved = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  let result;
  try { result = endStaleShardOffers(db, { root: repo.root, before: fix, dryRun: true }); }
  finally { if (saved === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = saved; }
  const reads = prepared.filter(sql => /\bFROM job\b/u.test(sql));
  assert.equal(reads.length, 1, `one read of the job table: ${JSON.stringify(prepared)}`);
  const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all('gate-shard').map(row => row.detail).join(' | ');
  assert.match(plan, /USING (?:COVERING )?INDEX/u, plan);
  assert.doesNotMatch(plan, /\bSCAN job\b/u, plan);
  const read = shards.length + current.length + 1;
  const checks = readFileSync(trace, 'utf8').split('\n').filter(line => /merge-base --is-ancestor/u.test(line)).length;
  assert.equal(checks, 3, `one ancestry check per distinct candidate (3) across ${read} shards`);
  assert.ok(checks < read);
  assert.ok(result.unknown.includes(UNREADABLE), 'the read covered every offered gate shard');
  assert.ok(!result.gates.some(one => one.shards.includes(unreadable)));
});

test('api.io-stale-shard-offers.gate-settles-red-to-builder: clause 3: once every shard is done the next runner claim settles the gate red, the item stays with its builder, and the red fact quotes the withdrawn detail [C7,#12166]', t => {
  const { repo, board, item, seat, fix, shards } = staleGate(t);
  const result = endStaleShardOffers(board.db, { root: repo.root, before: fix, now: 6 });
  assert.equal(result.ended, shards.length, 'every shard of the stale gate was offered and ends');
  boardJobQueueCall(board, { action: 'claim', runner: 'r-next', capabilities: [] }, { mode: 'pull', now: 50 });
  const held = store.getItem(board, item.item_id);
  assert.equal(held.item_status, 'claimed', 'the item stays claimed');
  assert.equal(held.item_owner, seat.id, 'by its builder');
  const red = store.itemThread(board, item.item_id).map(fact => fact.text ?? '').find(text => /^Gate job .* red at /u.test(text));
  assert.ok(red, `a red gate fact: ${store.itemThread(board, item.item_id).map(fact => fact.text).join(' | ')}`);
  assert.match(red, /ended: the gate's candidate does not contain main commit/u, red);
  assert.match(red, new RegExp(NEXT, 'u'), red);
  assert.doesNotMatch(red, /no proof phase/u, red);
});
