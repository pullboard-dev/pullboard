import { submitReusePlanDigest } from '../../../../packages/verify/index.js';
/** Exact submit receipts may replace a second execution only when every binding matches [C7,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { reusableSubmitProof } from '../../../../packages/verify/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), main = 'c'.repeat(40), frozen = 'd'.repeat(64);
const admission = '12345678-1234-1234-1234-123456789abc';
const item = { item_id: 7, item_frozen_digest: frozen };
const opts = { item, commit, tree, main, check: 'node check.js', affectedTests: 'node packages/gate/src/io/run/tests.js', gate: 'npm test', supplement: "node packages/gate/src/io/run/tests.js './test/a.test.js'" };
const event = (event_id, event_kind, detail) => ({ event_id, event_kind, event_by: 'web-1', event_detail: JSON.stringify(detail) });
function fixture() {
  const run = (id, phase, command) => ({ id, submitReuse: true, submitAdmission: admission, submitPhase: phase,
    submitReusePlan: submitReusePlanDigest({ check: opts.check, files: ['test/a.test.js'], full: false, deferred: false, proofCommand: opts.supplement }),
    kind: 'submit', item: 7, seat: 'web-1', commit, tree, main, frozenDigest: frozen, command: sha(command), sourceClean: true, green: true, exitCode: 0 });
  return [event(1, 'renew', { submitAdmission: { id: admission, commit, tree } }),
    event(2, 'proof-run', { receipt: run('criterion-id', 'criterion', opts.check) }),
    event(3, 'proof-run', { receipt: run('proof-id', 'proof', opts.supplement) }),
    event(4, 'submit', { commit, tree, policyCommit: main, criterionDigest: frozen, gateGreen: true,
      submissionProof: { files: ['test/a.test.js'], full: false, deferred: false } })];
}

test('exact admission, criterion and proof reuse their sealed run ids [C7,H16]', () => {
  assert.deepEqual(reusableSubmitProof(fixture(), opts), { ids: ['criterion-id', 'proof-id'], environment: null });
});

test('changed source, main, criterion or incomplete evidence fails closed [C7,H16]', () => {
  for (const changed of [{ main: 'e'.repeat(40) }, { tree: 'f'.repeat(40) }, { commit: 'e'.repeat(40) }, { check: 'node different.js' }, { supplement: 'node other.js' }]) {
    assert.ok(reusableSubmitProof(fixture(), { ...opts, ...changed }).reason);
  }
  for (const mutate of [
    rows => rows.splice(2, 1),
    rows => { const value = JSON.parse(rows[2].event_detail); value.receipt.green = false; rows[2].event_detail = JSON.stringify(value); },
    rows => { const value = JSON.parse(rows[2].event_detail); value.receipt.sourceClean = false; rows[2].event_detail = JSON.stringify(value); },
    rows => { const value = JSON.parse(rows[3].event_detail); value.submissionProof.deferred = true; rows[3].event_detail = JSON.stringify(value); },
    rows => { const value = JSON.parse(rows[3].event_detail); value.submissionProof.files = []; rows[3].event_detail = JSON.stringify(value); },
    rows => rows.splice(3, 0, event(3.5, 'proof-run', JSON.parse(rows[2].event_detail))),
  ]) { const rows = fixture(); mutate(rows); assert.ok(reusableSubmitProof(rows, opts).reason); }
});

async function nativeProofScenario(t, moveMain) {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { join } = await import('node:path');
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'proof-reuse-builder';
  sandbox.env.CODEX_THREAD_ID = 'proof-reuse-builder-session';
  const box = helpers.project('true', sandbox);
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/proof-input.txt'), 'original\n');
  box.git(box.repo, 'add', 'web/proof-input.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): seed proof input [G1]');
  box.git(box.web, 'merge', '--ff-only', 'main');
  const marker = join(box.dir, 'check-count');
  const check = `test -f web/proof-input.txt && printf x >> '${marker}'`;
  const added = fixtureAdd(box.run, box.repo, 'web', 'Proof reuse', '--specs', 'G1', '--criterion', 'the check is green', '--check', check, '--route', 'strong');
  assert.equal(added.code, 0, added.err || added.out);
  const claimed = box.run(box.web, 'claim', '1'); assert.equal(claimed.code, 0, claimed.err || claimed.out);
  const committed = helpers.commitFile(box, box.web, 'web/proof.js', 'export const proof = true;\n', 'feat(web): add proof fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.run(box.web, 'submit', '1'); assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const afterSubmit = readFileSync(marker, 'utf8'); assert.ok(afterSubmit.length > 0);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  box.env.CODEX_THREAD_ID = 'proof-reuse-reviewer-session';
  const joined = fixtureJoin(box.run, reviewer, 'web', '--model', 'proof-reuse-reviewer', '--route', 'strong'); assert.equal(joined.code, 0, joined.err || joined.out);
  if (moveMain) {
    box.env.CODEX_THREAD_ID = 'proof-reuse-builder-session';
    writeFileSync(join(box.repo, 'web/proof-input.txt'), 'changed\n');
    box.git(box.repo, 'add', 'web/proof-input.txt');
    box.git(box.repo, 'commit', '-q', '-m', 'test(web): change proof input [G1]');
    box.env.CODEX_THREAD_ID = 'proof-reuse-reviewer-session';
  }
  const verdict = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Read the submitted change against its frozen bar.');
  assert.equal(verdict.code, 0, verdict.err || verdict.out);
  if (moveMain) {
    assert.match(verdict.out, /submit proof not reused: (composed main changed|commit or tree changed)/);
    assert.equal(readFileSync(marker, 'utf8'), afterSubmit + 'x', 'moved main reruns the frozen check');
  } else {
    assert.match(verdict.out, /reused submit proof [a-f0-9-]{36}/); // The actual native receipt id is cited.
    assert.equal(readFileSync(marker, 'utf8'), afterSubmit, 'verification did not execute the frozen check again');
  }
}

test('native submit proof is reused while main stays pinned [C7,H16]', { timeout: 180000 }, t => nativeProofScenario(t, false));
test('native verification reruns when main moved [C7,H16]', { timeout: 180000 }, t => nativeProofScenario(t, true));

test('sealed reuse receipt replays its plan and refuses an older engine [C7,H16]', async t => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const store = await import('../../../../packages/store/index.js');
  const { openBoard } = await import('../../../lib/index.js');
  const { boardReceiptStore, receiptBody } = await import('../../../../packages/gate/index.js');
  const { prepareEngineMove, applyEngineMove } = await import('../../../../packages/state/index.js');
  const { SUBMIT_PROOF_REUSE_ENGINE } = await import('../../../../packages/state/light.js');
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-proof-reuse-'));
  const board = openBoard(join(dir, 'board.sqlite')), replica = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); store.closeBoard(replica); rmSync(dir, { recursive: true, force: true }); });
  let id;
  for (const target of [board, replica]) {
    store.register(target, { lane: 'coordinator', path: '/reuse-coordinator' });
    store.register(target, { lane: 'web', path: '/reuse-builder' });
    id = store.addItem(target, { by: 'coordinator', lane: 'web', title: 'Proof reuse boundary' });
  }
  const receipt = { version: 2, id: '00000000-0000-4000-8000-00000000cafe', kind: 'submit', head: commit, tree, main,
    command: sha('node check.js'), green: true, failures: [], load: null, at: '2026-10-23T00:00:00.000Z',
    proof: { item: id, frozenDigest: null, seat: 'web-1', environment: null, runner: null, exitCode: 0,
      counts: { passed: null, failed: null, skipped: null }, durationMs: 1, sourceClean: true,
      submitPhase: 'criterion', submitAdmission: admission, submitReuse: true, submitReusePlan: 'e'.repeat(64) } };
  assert.throws(() => store.recordProofRun(board, { agentId: 'web-1', itemId: id, receipt }), { code: 'PROOF_RUN_UNBOUND' });
  mkdirSync(boardReceiptStore(board)); writeFileSync(join(boardReceiptStore(board), `${receipt.id}.json`), receiptBody(receipt));
  const args = [{ agentId: 'web-1', itemId: id, receiptId: receipt.id }];
  const move = prepareEngineMove(board, 'recordProofRun', args, { actor: 'web-1' });
  assert.throws(() => applyEngineMove(replica, { ...move, engine: SUBMIT_PROOF_REUSE_ENGINE - 1 }, { sequence: 1, at: receipt.at }), /engine/u);
  const recorded = store.recordProofRun(board, args[0]);
  assert.equal(applyEngineMove(replica, move, { sequence: 1, at: receipt.at }).error, undefined);
  const [{ eventId, ...replayed }] = store.proofReceipts(replica, id);
  assert.deepEqual(replayed, recorded);
  assert.equal(replayed.submitReusePlan, 'e'.repeat(64));
  assert.equal(replayed.main, main);
});


test('a complete tiered unit proof is reusable while journeys stay deferred [C7,H16]', () => {
  const rows = fixture();
  const detail = JSON.parse(rows.at(-1).event_detail);
  detail.submissionProof.deferred = true;
  rows.at(-1).event_detail = JSON.stringify(detail);
  const expectedPlan = { check: opts.check, files: ['test/a.test.js'], full: false, deferred: true, proofCommand: opts.supplement, tiered: true };
  for (const row of rows.filter(row => row.event_kind === 'proof-run')) {
    const value = JSON.parse(row.event_detail);
    value.receipt.submitReusePlan = submitReusePlanDigest({ check: opts.check, files: expectedPlan.files, full: false, deferred: true, proofCommand: opts.supplement });
    row.event_detail = JSON.stringify(value);
  }
  assert.deepEqual(reusableSubmitProof(rows, { ...opts, expectedPlan }), { ids: ['criterion-id', 'proof-id'], environment: null });
  assert.ok(reusableSubmitProof(rows, { ...opts, expectedPlan: { ...expectedPlan, tiered: false } }).reason, 'ordinary deferred proof still cannot be cited');
  const missing = rows.filter(row => row.event_id !== 3);
  assert.ok(reusableSubmitProof(missing, { ...opts, expectedPlan }).reason, 'a missing unit proof receipt is never deferred away');
});
