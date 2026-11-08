/** Typed native pipeline observations never grant proof or infer a cause from prose [R1,R2,V4,H16,C7]. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { openBoard } from '../apps/lib/index.js';
import { PIPELINE_CAUSE_ENGINE } from '../src/pipeline-cause-engine.js';
import { pipelineCause, PIPELINE_CAUSES } from '../packages/kernel/index.js';
import { pipelineStats } from '../packages/stats/index.js';
import { submitFixture } from './board-submit-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

const BASE = Date.parse('2026-10-01T00:00:00Z');
const CRITERION = 'The page renders its title.';
/** Synthetic board-state gates below do not claim execution or production proof receipts. */
function fixture(t) {
  let seconds = 0;
  const board = openBoard(':memory:', { now: () => new Date(BASE + seconds * 1000) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/pipeline-causes/main' });
  const builder = store.register(board, { lane: 'web', path: '/pipeline-causes/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'web', path: '/pipeline-causes/reviewer', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Pipeline fixture', criterion: CRITERION, check: 'true' });
  const freeze = () => ({ text: JSON.stringify({ criterion: CRITERION, rows: [], policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'typed-pipeline-bar' });
  const claim = extra => store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze, ...extra });
  let admission = 0, submission = 0;
  const head = () => String.fromCharCode(97 + submission).repeat(40);
  const admit = () => claim({ submitAdmission: { id: String(++admission).padStart(8, '0') + '-0000-4000-8000-000000000000', commit: head(), tree: head() } });
  const submit = () => { const commit = head(); submitFixture(board, id, { agentId: builder, commit, tree: commit }); submission += 1; };
  const reserve = () => store.reserveReview(board, id, { agentId: reviewer, leaseMs: 3_600_000, policy: 'any' });
  const verdict = decision => store.verify(board, id, { agentId: reviewer, decision, reason: decision === 'REJECT' ? 'TEST_FAILURE' : undefined,
    note: decision === 'REJECT' ? 'The fixture title assertion failed.' : 'The fixture title assertion passed.', clause: CRITERION,
    head: store.getItem(board, id).item_commit, digest: 'typed-pipeline-bar', policy: 'any' });
  return { board, id, builder, reviewer, freeze, claim, admit, submit, reserve, verdict, at(value) { seconds = value; } };
}

test('native pipeline measures claim, admissions, deadline retry, test reject and landing exactly [R1,R2,V4,C7]', t => {
  const f = fixture(t);
  f.at(1); f.claim();
  f.at(11); f.claim({ submitOutcome: { digest: 'typed-pipeline-bar', code: 'RUNNER_WAIT_DEADLINE', text: 'The fixture runner deadline elapsed.' } });
  f.at(21); f.admit(); f.at(31); f.submit(); f.at(41); f.reserve(); f.at(51); f.verdict('REJECT');
  f.at(61); f.claim(); f.at(71); f.admit(); f.at(81); f.submit(); f.at(91); f.reserve(); f.at(101); f.verdict('ACCEPT');
  f.at(111); store.merged(f.board, f.id, { agentId: 'coordinator', commit: 'c'.repeat(40) });
  const report = pipelineStats(store.events(f.board));
  assert.deepEqual(report.items[0].stages, { claim: 30000, submit: 20000, reviewWait: 20000, review: 20000, landing: 10000 });
  assert.deepEqual(report.items[0].gaps, []);
  assert.deepEqual(report.items[0].retries.map(row => row.cause), ['runner-wait', 'test-failure']);
  assert.equal(report.causes.unknown, 0);
  const outcomes = store.events(f.board).map(e => JSON.parse(e.event_detail)).filter(d => d.submitOutcome);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].submitOutcome.pipelineCause.type, 'runner-wait');
  const admissions = store.events(f.board).filter(e => JSON.parse(e.event_detail).submitAdmission);
  assert.ok(admissions.every(e => Date.parse(e.event_at) > BASE + 11000), 'the runner deadline precedes real admission; a failed wait gets no invented witness');
  const rejected = store.events(f.board).find(e => e.event_kind === 'reject');
  assert.equal(JSON.parse(rejected.event_detail).pipelineCause.type, 'test-failure');
});

test('typed causes use structured evidence and preserve other text without narrative guesses [R1,R2,C7]', () => {
  const cases = [['RUNNER_WAIT_DEADLINE', 'runner-wait'], ['FLAKE', 'flake'], ['MAIN_RED', 'main-red'], ['CRITERIA_CHANGED', 'bar-change'],
    ['MERGE_CONFLICT', 'conflict'], ['ITEM_PATCH_CHANGED', 'companion-wait'], ['TEST_FAILURE', 'test-failure']];
  for (const [code, expected] of cases) assert.equal(pipelineCause({ code, note: 'fixture evidence' }).type, expected);
  assert.equal(pipelineCause({ cause: 'test:test/page.test.js::title' }).type, 'test-failure');
  assert.equal(pipelineCause({ cause: 'test:test/page.test.js::title', conflict: { files: ['web/page.js'] } }).type, 'conflict');
  for (const code of ['UNKNOWN_CODE', 'toString', 'GATE_RED']) {
    assert.deepEqual(pipelineCause({ code, note: 'runner wait flake main red conflict' }), { type: 'other', code, text: 'runner wait flake main red conflict' });
  }
  assert.deepEqual(PIPELINE_CAUSES, ['runner-wait', 'flake', 'main-red', 'bar-change', 'conflict', 'companion-wait', 'test-failure', 'host-busy', 'other']);
});

test('submit outcome cannot claim another seat, expired work, a changed bar or admission authority [V4,H16]', t => {
  const f = fixture(t); f.claim();
  const value = { digest: 'typed-pipeline-bar', code: 'RUNNER_WAIT_DEADLINE', text: 'fixture deadline' };
  const before = JSON.stringify(store.events(f.board));
  assert.throws(() => f.claim({ agentId: f.reviewer, submitOutcome: value }), { code: 'ITEM_LEASE_LOST' });
  assert.throws(() => f.claim({ submitOutcome: { ...value, digest: 'changed' } }), { code: 'ITEM_LEASE_LOST' });
  assert.throws(() => f.claim({ submitOutcome: value, submitAdmission: { id: '00000000-0000-4000-8000-000000000000', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } }), { code: 'ITEM_LEASE_LOST' });
  assert.equal(JSON.stringify(store.events(f.board)), before);
  f.at(3601);
  assert.throws(() => f.claim({ submitOutcome: value }), { code: 'ITEM_LEASE_LOST' });
  assert.equal(JSON.stringify(store.events(f.board)), before);
});

test('legacy reject and reopen event bytes gain no typed metadata during old-engine replay [H16,R2]', t => {
  const f = fixture(t); f.claim(); f.submit();
  f.board.executionEngineVersion = PIPELINE_CAUSE_ENGINE - 1;
  f.verdict('REJECT');
  const oldReject = store.events(f.board).find(e => e.event_kind === 'reject');
  assert.equal(Object.hasOwn(JSON.parse(oldReject.event_detail), 'pipelineCause'), false);
  delete f.board.executionEngineVersion;
  f.claim(); f.submit();
  f.board.executionEngineVersion = PIPELINE_CAUSE_ENGINE - 1;
  store.reopen(f.board, f.id, { agentId: 'coordinator', note: 'Explicit fixture correction, not an inferred failure.' });
  const oldReopen = store.events(f.board).find(e => e.event_kind === 'reopen');
  assert.equal(Object.hasOwn(JSON.parse(oldReopen.event_detail), 'pipelineCause'), false);
  delete f.board.executionEngineVersion;
  f.claim(); f.submit();
  store.reopen(f.board, f.id, { agentId: 'coordinator', note: 'Explicit fixture correction, not an inferred failure.' });
  const current = store.events(f.board).findLast(e => e.event_kind === 'reopen');
  assert.equal(JSON.parse(current.event_detail).pipelineCause.type, 'other');
  assert.equal(JSON.parse(current.event_detail).pipelineCause.text, 'Explicit fixture correction, not an inferred failure.');
});

const helpers = createE2eHelpers();
after(helpers.cleanup);
test('real refused submit records its original coded outcome without changing the refusal [V4,R2,C7]', () => {
  const box = helpers.project('true');
  const json = (root, ...args) => { const result = box.run(root, ...args, '--json'); assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  const added = json(box.repo, 'add', 'web', 'Submit outcome fixture', '--criterion', 'The page renders its title.', '--check', 'true');
  const id = added.item.item_id;
  json(box.web, 'claim', String(id));
  writeFileSync(join(box.web, 'uncommitted.txt'), 'private synthetic fixture dirt');
  const refused = box.run(box.web, 'submit', String(id), '--json');
  assert.equal(refused.code, 1, refused.out + refused.err);
  const document = JSON.parse(refused.out);
  assert.equal(document.error.code, 'UNTRACKED');
  // @pullboard-board-file persistence: inspect only this private CLI fixture's durable native outcome.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const event = store.events(board, { itemId: id }).findLast(e => JSON.parse(e.event_detail).submitOutcome);
    assert.ok(event, 'the genuine refused command records its native outcome');
    const outcome = JSON.parse(event.event_detail).submitOutcome;
    assert.equal(outcome.code, document.error.code);
    assert.equal(outcome.pipelineCause.type, 'other');
    assert.ok(outcome.text.includes('uncommitted.txt'));
    assert.equal(Object.hasOwn(JSON.parse(event.event_detail), 'submitAdmission'), false, 'a refusal never invents admission');
    assert.equal(store.getItem(board, id).item_status, 'claimed');
  } finally { store.closeBoard(board); }
});

test('real successful submit records immediate admission before its bound proof receipts [V4,R2,H16]', () => {
  const gate = 'node --test web/title.test.js';
  const box = helpers.project(gate);
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/title.js'), "export const title = 'before';\n");
  writeFileSync(join(box.repo, 'web/title.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from './title.js';\ntest('the title is corrected [G1]', () => assert.equal(title, 'after'));\n");
  box.git(box.repo, 'add', 'web/title.js', 'web/title.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: establish private admission fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const json = (root, ...args) => { const result = box.run(root, ...args, '--json'); assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  const added = json(box.repo, 'add', 'web', 'Immediate admission fixture', '--criterion', 'The title is corrected.', '--check', gate);
  const id = added.item.item_id;
  json(box.web, 'claim', String(id));
  writeFileSync(join(box.web, 'web/title.js'), "export const title = 'after';\n");
  box.git(box.web, 'add', 'web/title.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): correct private fixture title [G1]');
  const submitted = json(box.web, 'submit', String(id), '--no-next');
  assert.equal(submitted.gate.green, true);
  // @pullboard-board-file persistence: observe only the successful private fixture's native admission/proof order.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const events = store.events(board, { itemId: id });
    const admissions = events.filter(e => JSON.parse(e.event_detail).submitAdmission);
    assert.equal(admissions.length, 1, 'even a free-slot submit records one genuine admission');
    const admission = JSON.parse(admissions[0].event_detail).submitAdmission;
    assert.equal(admission.commit, submitted.commit);
    const receipts = events.filter(e => e.event_kind === 'proof-run').map(e => ({ event: e, receipt: JSON.parse(e.event_detail).receipt }));
    assert.ok(receipts.length > 0, 'the real gate produced native proof receipts');
    for (const { event, receipt } of receipts) {
      assert.ok(event.event_id > admissions[0].event_id);
      assert.equal(receipt.commit, admission.commit);
      assert.equal(receipt.tree, admission.tree);
    }
    const final = receipts.filter(({ receipt }) => receipt.submitAdmission === admission.id);
    assert.ok(final.length > 0, 'the final formal proof binds the admitted claim; criterion receipts keep their separate authority');
  } finally { store.closeBoard(board); }
});

test('clause 3: stats pipeline classifies BOARD_BUSY, GIT_READ_INFRASTRUCTURE and DATABASE_LOCKED as host-busy with zero unknown causes [C7]', t => {
  const f = fixture(t);
  f.at(1); f.claim();
  for (const [index, code] of ['BOARD_BUSY', 'GIT_READ_INFRASTRUCTURE', 'DATABASE_LOCKED'].entries()) {
    f.at(10 + index * 10); f.claim({ submitOutcome: { digest: 'typed-pipeline-bar', code, text: `The fixture host reported ${code}.` } });
  }
  f.at(50); f.admit(); f.at(60); f.submit(); f.at(70); f.reserve(); f.at(80); f.verdict('ACCEPT');
  f.at(90); store.merged(f.board, f.id, { agentId: 'coordinator', commit: 'c'.repeat(40) });
  const report = pipelineStats(store.events(f.board));
  assert.deepEqual(report.items[0].retries.map(row => row.cause), ['host-busy', 'host-busy', 'host-busy']);
  assert.equal(report.causes.unknown, 0);
  assert.equal(report.causes['host-busy'], 3);
});
