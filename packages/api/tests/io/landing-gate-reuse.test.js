/** With landing.reuseGateReceipts on, the land request's hit list carries the item's own green gate results first; off, it is exactly today's [C7,#9243]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { recordTestResults } from '../../../store/index.js';
import { offerLandingJob } from '../../index.js';
import { claimJob } from '../../index.js';
import { jobRequest } from '../../index.js';
import { offerJob } from '../../index.js';
import { offeredRequest } from '../../index.js';
import { acceptedLandingMembers } from '../fixtures/landing-members.js';
import { CRITERION_ONLY } from '../fixtures/landing-members.js';
import { CROSS_RUN } from '../fixtures/landing-members.js';
import { DEFERRED } from '../fixtures/landing-members.js';
import { OWED } from '../fixtures/landing-members.js';

const COMMIT = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const CONTEXT = 'c'.repeat(64);
const key = n => n.toString(16).padStart(64, '0');
const FILES = ['packages/area/tests/a.test.js', 'packages/area/tests/b.test.js'];
let offers = 0;

/** A board where the item's gate (at COMMIT) proved both files at key 1, then three newer runs elsewhere proved other keys for the same files. */
function board(t, { fail = false } = {}) {
  const db = cellBoard(t, ':memory:').db;
  const row = (file, inputKey, status = 'pass') => ({ file, inputKey: key(inputKey), command: 'proof', context: CONTEXT, status });
  recordTestResults(db, { receipt: 'gate:item#0', origin: 'pulled:r-1', commit: COMMIT, rows: FILES.map(file => row(file, 1)) });
  for (const at of [2, 3, 4]) recordTestResults(db, { receipt: `gate:other-${at}#0`, origin: 'pulled:r-2', commit: OTHER, rows: FILES.map(file => row(file, at)) });
  if (fail) recordTestResults(db, { receipt: 'gate:red#0', origin: 'pulled:r-3', commit: COMMIT, rows: [row(FILES[1], 1, 'fail')] });
  return db;
}

/** Offer one land job for the item and return its payload. */
function offered(db, extra = {}) {
  const id = 9243 + ++offers;
  const job = offerLandingJob(db, { items: [{ id, commit: COMMIT, ref: `refs/pullboard/land/${id}` }], expect: 'b'.repeat(40), config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' }, ...extra });
  return job.steps.find(step => step.name === 'offered').payload.payload;
}

/** The hit list as [file, inputKey] pairs. */
const hits = payload => payload.proof.ledger.files.map(([file, inputKey]) => `${file}@${Number.parseInt(inputKey, 16)}`).sort();

/** Read exactly what the leased land worker receives, retaining the entire combined plan alongside member scopes. */
function memberRoundTrip(board, members, base, { stored }) {
  const items = [...members.map(({ id, commit }) => ({ id, commit })), { id: 99000, commit: members[0].commit }];
  const job = offerLandingJob(board.db, { items, expect: base,
    config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node --test' }, reuseGateReceipts: true });
  const offered = job.steps.find(step => step.name === 'offered').payload;
  const request = offeredRequest(board.db, job.id);
  const before = { ...offered.payload, ...request?.land };
  assert.equal(offered.payload.requested?.includes('proof') ?? false, stored, 'the actual requested transport path is exercised');
  assert.ok(Buffer.byteLength(JSON.stringify(offered.payload)) <= 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(offered.request ?? null)) <= 60 * 1024);
  const held = claimJob(board.db, { runner: 'r-member-roundtrip', capabilities: [], kinds: ['land'] });
  assert.equal(held.job, job.id);
  assert.throws(() => jobRequest(board.db, { job: job.id, runner: 'r-other', token: held.token }), error => error.code === 'JOB_LEASE_MOVED');
  const read = jobRequest(board.db, { job: job.id, runner: 'r-member-roundtrip', token: held.token });
  assert.ok(Buffer.byteLength(JSON.stringify(read.request)) <= 4 * 1024 ** 2);
  const after = { ...held.payload, ...read.request?.land };
  assert.deepEqual(after.proof, before.proof, 'complete and unknown member records and the combined proof survive byte transport exactly');
  const union = [...new Set(members.flatMap(member => member.proofFiles))].sort();
  assert.deepEqual(after.proof.files, union, 'the full combined batch union remains required');
  assert.deepEqual(after.proof.members.map(scope => scope.status), ['complete', 'complete', 'unknown']);
  for (const [index, member] of members.entries()) {
    const scope = after.proof.members[index];
    assert.deepEqual(scope.required, [...new Set([...member.proofFiles, CRITERION_ONLY, DEFERRED, OWED])].sort());
    assert.ok(scope.required.includes(CROSS_RUN), 'the real accepted cross-run floor is mandatory after hydration');
    assert.equal(scope.frozenDigest, member.digest);
    assert.equal(scope.commit, member.commit);
    assert.equal(scope.provenance.receipts.length, 2);
  }
  assert.deepEqual(after.proof.members[2], { item: 99000, commit: members[0].commit, status: 'unknown', reason: 'member is not accepted at this commit' }, 'a complete flat passing list cannot certify a member');
  console.log(`member-transport observation ${JSON.stringify({ stored, files: union.length, payloadBytes: Buffer.byteLength(JSON.stringify(offered.payload)), offeredRequestBytes: Buffer.byteLength(JSON.stringify(offered.request ?? null)), hydratedBytes: Buffer.byteLength(JSON.stringify(read.request)), statuses: after.proof.members.map(scope => scope.status) })}`);
}

test('api.landing-gate-reuse.member-inline-roundtrip: inline authenticated offer/readback retains complete and unknown scopes, mandatory cross-run floor and the full combined union [C7,#12972]', t => {
  const { board, members, base } = acceptedLandingMembers(t);
  memberRoundTrip(board, members, base, { stored: false });
});

test('api.landing-gate-reuse.member-stored-roundtrip: stored authenticated offer/readback retains complete and unknown scopes beyond inline size without truncating the batch or raising bounds [C7,#12972]', t => {
  const extraFiles = Array.from({ length: 697 }, (_, index) => `docs/retained-${index}.test.js`);
  const { board, members, base } = acceptedLandingMembers(t, { extraFiles });
  memberRoundTrip(board, members, base, { stored: true });
});

test('api.landing-gate-reuse.member-unknown-authority: missing, incomplete, ambiguous and stale native evidence stays unknown despite a passing flat file list [C7,#12972]', t => {
  for (const fault of ['missing', 'incomplete', 'ambiguous', 'stale']) {
    const { board, members, base } = acceptedLandingMembers(t, { fault });
    const items = members.map(({ id, commit }) => ({ id, commit }));
    if (fault === 'stale') items[1].commit = members[0].commit;
    const job = offerLandingJob(board.db, { items, expect: base,
      config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node --test' }, reuseGateReceipts: true });
    const offered = job.steps.find(step => step.name === 'offered').payload;
    const proof = offered.payload.proof ?? offeredRequest(board.db, job.id).land.proof;
    assert.equal(proof.members[0].status, 'complete', `${fault}: the unaffected owner's native proof remains complete`);
    assert.equal(proof.members[1].status, 'unknown', `${fault}: ${JSON.stringify(proof.members[1])}`);
    assert.equal('required' in proof.members[1], false, 'unknown never exposes a finite certified scope');
    assert.ok(proof.files.includes(CROSS_RUN), 'unknown does not remove the combined floor');
    assert.ok(proof.ledger.files.length > 0, 'the negative really has passing flat file evidence');
    console.log(`member-unknown observation ${JSON.stringify({ fault, scope: proof.members[1], combined: proof.files })}`);
  }
});

test('api.landing-gate-reuse.complete-member-obligations: the actual two-member offer binds each accepted finite selection and frozen cross-file obligations independently of import reach [C7,#12971]', t => {
  const { board, members, base } = acceptedLandingMembers(t);
  const job = offerLandingJob(board.db, { items: members.map(({ id, commit }) => ({ id, commit })), expect: base,
    config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node --test' }, reuseGateReceipts: true });
  const offered = job.steps.find(step => step.name === 'offered').payload;
  const proof = offered.payload.proof ?? offered.request.land.proof;
  assert.equal(proof.members.length, 2);
  for (const [index, member] of members.entries()) {
    const scope = proof.members[index];
    assert.equal(scope.status, 'complete', JSON.stringify(scope));
    assert.deepEqual([scope.item, scope.commit, scope.tree, scope.policyCommit, scope.claimBase, scope.tooling], [member.id, member.commit, member.tree, base, base, base]);
    assert.equal(scope.frozenDigest, member.digest);
    assert.deepEqual(scope.frozen, member.frozen);
    assert.equal(scope.check, member.check);
    assert.deepEqual(scope.selection.files, member.proofFiles);
    assert.equal(scope.selection.full, false);
    assert.equal(scope.selection.deferred, true);
    assert.deepEqual(scope.selection.deferredFiles, [DEFERRED]);
    assert.deepEqual(scope.selection.owedFiles, [OWED]);
    assert.deepEqual(scope.required, [...new Set([...member.proofFiles, CRITERION_ONLY, DEFERRED, OWED])].sort());
    assert.ok(scope.required.includes(CROSS_RUN), 'the accepted cross-run selection remains required');
    assert.equal(scope.provenance.job, member.job);
    assert.equal(scope.provenance.receipts.length, 2, 'both native admission-bound phases authorize the plan');
  }
  assert.ok(!members[0].proofFiles.includes(CRITERION_ONLY), 'the explicit frozen obligation is outside web import selection');
  assert.ok(proof.members[0].required.includes(CRITERION_ONLY), 'a test importing only sibling API source still belongs to web\'s explicit frozen bar');
  assert.ok(!proof.members[0].required.includes('api/own.test.js'), 'the sibling\'s unrelated selection does not become web\'s own obligation');
  console.log(`member-obligations observation ${JSON.stringify(proof.members.map(({ item, required, provenance }) => ({ item, required, job: provenance.job, receipts: provenance.receipts.length })))}`);
});

test('api.landing-gate-reuse.landing-reusegatereceipts-hit-list-lists: clause 1: with landing.reuseGateReceipts on, the hit list lists the item\'s green gate results for its files [C7,#9243]', t => {
  const payload = offered(board(t), { reuseGateReceipts: true });
  assert.ok(FILES.every(file => hits(payload).includes(`${file}@1`)), 'both files hit at the key the item\'s gate proved');
  assert.equal(payload.reuseGateReceipts, true, 'the job says the setting is on, for the runner');
});

test('api.landing-gate-reuse.off-hit-list-exactly-today: clause 2: with it off the hit list is exactly today\'s and the setting is not on the job [C7,#9243]', t => {
  const payload = offered(board(t));
  assert.deepEqual(hits(payload), FILES.flatMap(file => [`${file}@3`, `${file}@4`]).sort(), 'the newest two rows of any origin, as before');
  assert.equal('reuseGateReceipts' in payload, false);
});

test('api.landing-gate-reuse.gate-result-fail-row-same: clause 2: a gate result with a fail row at the same key is not a hit, setting on [C7,#9243]', t => {
  const payload = offered(board(t, { fail: true }), { reuseGateReceipts: true });
  assert.ok(hits(payload).includes(`${FILES[0]}@1`));
  assert.equal(hits(payload).includes(`${FILES[1]}@1`), false, 'a key that also failed is run, never reused');
});


test('api.landing-gate-reuse.stored-accepted-proof-complete: clause 1: a real stored offer and authenticated readback carry more than 500 accepted file proofs beyond the inline ledger budget [C7,#12965]', t => {
  const db = cellBoard(t, ':memory:').db;
  const files = Array.from({ length: 697 }, (_, index) => `packages/area/tests/io/accepted-file-${index}.test.js`);
  recordTestResults(db, { receipt: 'gate:accepted-large#0', origin: 'pulled:r-accepted', commit: COMMIT,
    rows: files.map((file, index) => ({ file, inputKey: key(index + 1), command: 'proof', context: CONTEXT, status: 'pass' })) });
  const job = offerLandingJob(db, { items: [{ id: 12965, commit: COMMIT, ref: 'refs/pullboard/land/12965' }], expect: OTHER,
    config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' }, reuseGateReceipts: true });
  const offered = job.steps.find(step => step.name === 'offered').payload;
  assert.ok(offered.payload.requested.includes('proof'), 'the actual offer moves proof to stored transport');
  assert.ok(Buffer.byteLength(JSON.stringify(offered.payload)) <= 16 * 1024, 'the existing payload cap is unchanged');
  assert.ok(Buffer.byteLength(JSON.stringify(offered.request)) <= 60 * 1024, 'the existing inline request cap is unchanged');
  const held = claimJob(db, { runner: 'r-stored-proof', capabilities: [], kinds: ['land'] });
  assert.equal(held.job, job.id);
  assert.throws(() => jobRequest(db, { job: job.id, runner: 'r-other', token: held.token }), error => error.code === 'JOB_LEASE_MOVED');
  const read = jobRequest(db, { job: job.id, runner: 'r-stored-proof', token: held.token });
  assert.ok(Buffer.byteLength(JSON.stringify(read.request)) <= 4 * 1024 ** 2, 'the stored request fits its original bound');
  const proof = read.request.land.proof;
  assert.deepEqual(proof.files, files.slice().sort(), 'selection includes every accepted file');
  const names = new Set(proof.ledger.files.map(row => row[0]));
  console.log(`stored-proof observation ${JSON.stringify({ selected: proof.files.length, carried: names.size, ledgerBytes: Buffer.byteLength(JSON.stringify(proof.ledger)), requestBytes: Buffer.byteLength(JSON.stringify(read.request)) })}`);
  assert.equal(names.size, files.length, 'every eligible accepted file proof survives stored transport');
  assert.ok(Buffer.byteLength(JSON.stringify(proof.ledger)) > 16_000, 'the proof really exceeds the old inline ledger budget');
  assert.deepEqual(proof.ledger.contexts, [CONTEXT]);
  for (const [index, file] of files.entries()) assert.ok(proof.ledger.files.some(row => row[0] === file && row[1] === key(index + 1) && row[2] === 0), 'the exact file, input and context tuple is unchanged');
});


test('api.landing-gate-reuse.stored-proof-negative-controls: clause 2: stored transport preserves accepted precedence, shadowed failure rejection, exact tuple bindings and original request bounds [C7,#12965]', t => {
  const db = board(t, { fail: true });
  const extra = Array.from({ length: 650 }, (_, index) => ({ file: `packages/area/tests/io/control-${index}.test.js`, inputKey: key(index + 10), command: 'proof', context: CONTEXT, status: 'pass' }));
  recordTestResults(db, { receipt: 'gate:large-controls#0', origin: 'pulled:r-controls', commit: COMMIT, rows: extra });
  const job = offerLandingJob(db, { items: [{ id: 1296502, commit: COMMIT, ref: 'refs/pullboard/land/1296502' }], expect: OTHER,
    config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' }, reuseGateReceipts: true });
  const held = claimJob(db, { runner: 'r-negative', capabilities: [], kinds: ['land'] });
  const request = jobRequest(db, { job: job.id, runner: 'r-negative', token: held.token }).request;
  const proof = request.land.proof, rows = proof.ledger.files;
  assert.ok(rows.length > 500, 'negative controls exercise the large stored path');
  assert.equal(rows.find(row => row[0] === FILES[0])[1], key(1), 'accepted proof precedes newer other-commit inputs');
  assert.equal(rows.some(row => row[0] === FILES[1] && row[1] === key(1)), false, 'a shadowed accepted pass is still ineligible');
  assert.equal(rows.some(row => row[0] === 'packages/area/tests/missing.test.js'), false, 'missing evidence is not invented');
  const first = rows.find(row => row[0] === extra[0].file);
  assert.deepEqual([first[0], first[1], proof.ledger.contexts[first[2]]], [extra[0].file, extra[0].inputKey, CONTEXT], 'transport retains all three matching dimensions');
  assert.equal(rows.some(row => row[0] === first[0] && row[1] === key(999999)), false, 'changed inputs are not certified');
  assert.equal(rows.some(row => row[0] === first[0] && proof.ledger.contexts[row[2]] === 'f'.repeat(64)), false, 'incompatible execution context is not certified');
  assert.throws(() => offerJob(db, { id: 'bounds:payload', kind: 'test', payload: { text: 'x'.repeat(16 * 1024) } }), error => error.code === 'JOB_PAYLOAD');
  assert.throws(() => offerJob(db, { id: 'bounds:request', kind: 'test', request: { text: 'x'.repeat(4 * 1024 ** 2) } }), error => error.code === 'JOB_REQUEST');
});
