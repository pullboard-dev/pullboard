/** A runner holds no more gate-shard jobs than its cores allow, so a gate's shards spread over every runner that polls [C7,#7765]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { SHARD_JOB_KIND } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { shardClaimCap } from '../../index.js';
import { releaseJob } from '../../index.js';
import { combinedReceipt } from '../../index.js';
import { compareGateWithMain } from '../../index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

/** Offer `count` shard jobs of one dry push gate, oldest first. */
function offerShards(db, count) {
  for (let at = 1; at <= count; at += 1) offerJob(db, { id: `push:abc:tag:shard:${at}`, kind: SHARD_JOB_KIND, priority: 'gate', now: at });
}

test('api.shards.runner-takes-gate-shard-per: clause 1: a runner takes one gate shard per three cores and no more, so the other runners get the remaining shards [C7,#7765]', t => {
  const db = boardWith(t);
  offerShards(db, 18);
  const now = 1_000;
  const take = (runner, cores, jobs) => claimJob(db, { runner, cores, jobs, now });
  // Two fast runners with ten cores and ten slots each poll first, as .56 and .55 did.
  const taken = { r56: [], r55: [] };
  for (let tries = 0; tries < 18; tries += 1) for (const runner of ['r56', 'r55']) { const claim = take(runner, 10, 10); if (claim) taken[runner].push(claim.job); }
  assert.equal(shardClaimCap(10), 3);
  assert.deepEqual([taken.r56.length, taken.r55.length], [3, 3], 'each takes its cap of three, not eight or ten');
  // The four idle runners that polled later get the other twelve.
  const others = ['r51', 'r52', 'r53', 'r54'].map(runner => { const mine = []; for (let tries = 0; tries < 18; tries += 1) { const claim = take(runner, 10, 10); if (claim) mine.push(claim.job); } return mine.length; });
  assert.deepEqual(others, [3, 3, 3, 3], 'each idle runner takes three of the rest');
  assert.equal(take('r-late', 10, 10), null, 'all eighteen are held');
});

test('api.shards.finished-released-shard-frees-slot: clause 1: a finished or released shard frees a slot; a one-core runner holds one shard; a runner not reporting cores is not capped; other kinds are never capped [C7,#7765]', t => {
  const db = boardWith(t);
  offerShards(db, 6);
  const first = claimJob(db, { runner: 'r-small', cores: 2, now: 10 });
  assert.equal(shardClaimCap(2), 1, 'a runner holds at least one shard');
  assert.equal(claimJob(db, { runner: 'r-small', cores: 2, now: 11 }), null, 'a second shard waits for the first');
  releaseJob(db, { job: first.job, runner: 'r-small', token: first.token, reason: 'test', backoff: false, now: 12 });
  assert.ok(claimJob(db, { runner: 'r-small', cores: 2, now: 13 }), 'a free slot takes the next shard');
  const old = [claimJob(db, { runner: 'r-old', now: 14 }), claimJob(db, { runner: 'r-old', now: 15 })];
  assert.ok(old.every(Boolean), 'a runner that reports no cores keeps the old claim behaviour');
  offerJob(db, { id: 'gate:other', kind: 'gate', now: 20 });
  offerJob(db, { id: 'test:other', kind: 'test', now: 21 });
  const kinds = [claimJob(db, { runner: 'r-small', cores: 2, now: 22 }), claimJob(db, { runner: 'r-small', cores: 2, now: 23 })].map(claim => claim?.kind);
  assert.deepEqual(kinds.sort(), ['gate', 'test'], 'a runner at its shard cap still claims every other kind of job');
});

test('api.shards.runner-free-slot-takes-offered: clause 2: a runner with a free slot takes an offered push-gate shard before an item gate or a test job, and still stops at its shard cap [C7,#7790]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:item-1', kind: 'gate', now: 1 });
  offerJob(db, { id: 'test:run-1', kind: 'test', now: 2 });
  offerJob(db, { id: 'land:one', kind: 'land', now: 3 });
  offerShards(db, 2);
  const order = [1, 2, 3, 4, 5].map(at => claimJob(db, { runner: 'r-free', cores: 3, jobs: 5, now: 100 + at })?.job);
  assert.deepEqual(order.slice(0, 1), ['push:abc:tag:shard:1'], 'the shard comes first though every other job is older');
  assert.equal(order.includes('push:abc:tag:shard:2'), false, 'the cap of one shard per three cores holds (#7765)');
  assert.deepEqual(order.slice(1).sort(), ['gate:item-1', 'land:one', 'test:run-1', undefined].sort(), 'the capped runner still takes every other job');
});

test('api.shards.push-shard-first-under-priority: clause 2: a push shard is first under a priority reserve too, and a gate-shard job not named push: gets no such rank [C7,#7790]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'test:run-1', kind: 'test', priority: 'interactive', now: 1 });
  offerJob(db, { id: 'shard:other', kind: SHARD_JOB_KIND, now: 2 });
  offerJob(db, { id: 'push:abc:tag:shard:1', kind: SHARD_JOB_KIND, priority: 'gate', now: 3 });
  const reserve = { interactive: 0.25 };
  assert.equal(claimJob(db, { runner: 'r-a', jobs: 4, reserve, now: 10 }).job, 'push:abc:tag:shard:1', 'a reserve does not push a shard behind a test');
  assert.equal(claimJob(db, { runner: 'r-b', jobs: 4, now: 11 }).job, 'test:run-1', 'a gate-shard job outside a push gate keeps its place after a test');
});

test('api.shards.cores-per-shard-sets-cap: clause 1: shardClaimCap(10, 2) is 5 while claimJob given cores 10 and coresPerShard 2 hands one runner five gate shards, and with no coresPerShard it hands three [C7,#11867]', t => {
  assert.equal(shardClaimCap(10, 2), 5);
  assert.equal(shardClaimCap(10), 3);
  const held = (coresPerShard) => {
    const db = boardWith(t);
    offerShards(db, 8);
    let taken = 0;
    for (let tries = 0; tries < 8; tries += 1) if (claimJob(db, { runner: 'r-ten', cores: 10, jobs: 10, now: 1_000, ...(coresPerShard ? { coresPerShard } : {}) })) taken += 1;
    return taken;
  };
  assert.equal(held(2), 5);
  assert.equal(held(null), 3);
});

test('api.gate-owner.routes-authenticated-failure-to-selected-shard: clause 1: an authenticated failed unskipped fixture case is compared under its exact selected owner while retaining its source, name, signature and shard [C7]', t => {
  const db = boardWith(t), board = { db, gitRoot: '.' };
  const head = 'a'.repeat(40), main = 'c'.repeat(40), source = 'tests/fixtures/shared.js', owner = 'tests/wrappers/one.test.js';
  const name = 'shared fixture case [C7]';
  const signature = 'b'.repeat(64), inputKey = 'd'.repeat(64), shard = 'gate:12922:shard:1';
  const phase = { role: 'proof', status: 1, failures: [{ file: source, name }], failureSignatures: [signature],
    testOutcomes: [{ file: source, name, owner, passed: false, skipped: false, failure: 'assertion' }], tail: 'not ok' };
  const posted = { attempt: 1, runner: 'runner-one', receipt: { status: 1, gate: { source: head, green: false, shard: { files: [owner] }, phases: [phase] } } };
  const combined = combinedReceipt({ status: 0, gate: { source: head, green: true, phases: [{ role: 'check', status: 0 }], proofPlan: {} } },
    [{ job: shard, posted, selected: { files: [owner], keys: { [owner]: inputKey } } }], { signatures: true });
  let observed;
  const compared = compareGateWithMain(board, combined, main, request => {
    observed = request;
    return { classes: [{ file: owner, owner: 'item', own: [name], receipt: null, job: null }] };
  });
  assert.deepEqual(observed.cases, [{ file: owner, name }], 'lookup receives the selected wrapper, not the fixture');
  assert.equal(observed.inputKeys[owner], inputKey, 'lookup receives the selected wrapper input key');
  assert.equal(observed.inputKeys[source], undefined, 'the fixture input key is not borrowed');
  assert.deepEqual({ file: compared.cases[0].file, caseFile: compared.cases[0].caseFile, name: compared.cases[0].name,
    signature: compared.cases[0].signature, shard: compared.cases[0].shard, attempt: compared.cases[0].attempt, head: compared.cases[0].head },
  { file: owner, caseFile: source, name, signature, shard, attempt: 1, head });
});

test("api.gate-owner.rejects-foreign-and-malformed-owner-routes: clause 2: each shard's own selection governs ownership and malformed, skipped, missing and duplicate identities never receive an owner route [C7]", t => {
  const db = boardWith(t), board = { db, gitRoot: '.' };
  const head = 'e'.repeat(40), main = 'f'.repeat(40), source = 'tests/fixtures/shared.js', owner = 'tests/wrappers/one.test.js';
  const name = 'same case [C7]', signature = '1'.repeat(64), inputKey = '2'.repeat(64), shard = 'gate:12922:shard:1';
  const make = (outcomes, selectedFiles = [owner]) => combinedReceipt({ status: 0, gate: { source: head, green: true, phases: [], proofPlan: {} } }, [{ job: shard,
    selected: { files: selectedFiles, keys: { [owner]: inputKey } }, posted: { attempt: 1, runner: 'runner', receipt: { status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1,
      failures: [{ file: source, name }], failureSignatures: [signature], ...(outcomes === undefined ? {} : { testOutcomes: outcomes }) }] } } } }], { signatures: true });
  const lookup = () => ({ classes: [{ file: owner, owner: 'item', own: [name], receipt: null, job: null }] });
  for (const [outcomes, files] of [
    [[{ file: source, name, owner, passed: false, skipped: false, failure: 'assertion' }], ['tests/wrappers/two.test.js']],
    [[{ file: source, name, owner: '../outside.test.js', passed: false, skipped: false, failure: 'assertion' }], [owner]],
    [[{ file: source, name, owner, passed: false, skipped: true, failure: 'assertion' }], [owner]],
    [[{ file: source, name, owner, passed: false, skipped: false, failure: 'assertion' }, { file: source, name, owner, passed: false, skipped: false, failure: 'assertion' }], [owner]],
    [[], [owner]],
  ]) assert.equal(compareGateWithMain(board, make(outcomes, files), main, lookup), null, 'untrusted or ambiguous owner evidence is fail closed');
  const other = 'tests/wrappers/two.test.js';
  const parts = [owner, other].map((selectedOwner, index) => ({ job: `gate:12922:shard:${index + 1}`,
    selected: { files: [selectedOwner], keys: { [selectedOwner]: String(index + 3).repeat(64) } },
    posted: { attempt: 1, runner: `runner-${index}`, receipt: { status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1,
      failures: [{ file: source, name }], failureSignatures: [signature], testOutcomes: [{ file: source, name, owner: selectedOwner, passed: false, skipped: false, failure: 'assertion' }] }] } } } }));
  let observed;
  const shared = compareGateWithMain(board, combinedReceipt({ status: 0, gate: { source: head, green: true, phases: [], proofPlan: {} } }, parts, { signatures: true }), main, request => {
    observed = request;
    return { classes: [owner, other].map(file => ({ file, owner: 'item', own: [name], receipt: null, job: null })) };
  });
  assert.deepEqual(observed.cases, [{ file: owner, name }, { file: other, name }], 'same fixture identity is resolved independently inside each shard');
  assert.deepEqual(observed.inputKeys, { [owner]: '3'.repeat(64), [other]: '4'.repeat(64) }, 'each wrapper keeps only its shard input key');
  assert.deepEqual(shared.cases.map(row => [row.file, row.caseFile, row.shard]), [[owner, source, 'gate:12922:shard:1'], [other, source, 'gate:12922:shard:2']]);
  const legacy = compareGateWithMain(board, make(undefined), main, request => {
    assert.deepEqual(request.cases, [{ file: source, name }], 'an old receipt keeps conservative source-path comparison');
    return { classes: [{ file: source, owner: 'item', own: [name], receipt: null, job: null }] };
  });
  assert.equal(legacy.cases[0].file, source, 'legacy proof never borrows an inferred owner');
});
