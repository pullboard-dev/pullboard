import { CLAUSE_INSPECTION_ENGINE } from '../src/clause-inspection-engine.js';
/** Prove clause inspection: an unticked clause refuses submit and is named, free text is unaffected [#2050]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { clauseInspectionProblem } from '../packages/state/index.js';
import { clauseInspectionSummary } from '../packages/state/index.js';
import { criterionClauses } from '../packages/state/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const HOUR = 3_600_000;
const THREE = 'the bar is met when:\n1. the list renders [test]\n2. the count shows 3 [command]\n3. the page is clear at 375px [screenshot]';

/** A claimed item whose criterion is the given text. */
function fixture(t, criterion) {
  const board = openBoard(':memory:');
  store.register(board, { lane: 'coordinator', path: '/fixture/main' });
  store.register(board, { lane: 'core', path: '/fixture/builder' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Clause fixture', criterion, route: 'mid',
    brief: 'Files: src/a.js\nTest: one named case', check: 'true' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 2 * HOUR, freeze: item => ({ text: item.item_criterion, digest: 'clauses' }) });
  t.after(() => store.closeBoard(board));
  return { board, id };
}
const problem = ({ board, id }) => clauseInspectionProblem(store.getItem(board, id), store.itemThread(board, id));
const tick = ({ board, id }, text) => store.appendFact(board, id, { agentId: 'core-1', kind: 'note', text });

test('a three-clause criterion refuses submit with one unticked and names it, then accepts when all carry evidence [V4,B3]', t => {
  const f = fixture(t, THREE);
  assert.equal(criterionClauses(THREE).length, 3);
  assert.match(problem(f).message, /clause 1 .*no evidence.*clause 2 .*no evidence.*clause 3 .*no evidence/u);
  tick(f, 'clause 1 [test]: test/list.test.js "renders" passes');
  tick(f, 'clause 3 [screenshot]: shots/375.png shows no overflow');
  const refusal = problem(f);
  assert.equal(refusal.code, 'CLAUSE_UNTICKED');
  assert.match(refusal.message, /clause 2 \(the count shows 3/u);
  assert.doesNotMatch(refusal.message, /clause 1|clause 3/u, 'only the unticked clause is named');
  tick(f, 'clause 2 [command]: node bin/x.js count prints 3');
  assert.equal(problem(f), null);
  const summary = clauseInspectionSummary(store.getItem(f.board, f.id), store.itemThread(f.board, f.id));
  assert.match(summary, /1\. the list renders.*test: test\/list\.test\.js/u);
  assert.match(summary, /3\. .*screenshot: shots\/375\.png/u);
});

test('reasoning is flagged weakest and cannot stand in for a declared test or command [V4,B3]', t => {
  const f = fixture(t, THREE);
  tick(f, 'clause 1 [reasoning]: it obviously renders');
  tick(f, 'clause 2 [command]: prints 3');
  tick(f, 'clause 3 [reasoning]: looks fine');
  assert.match(problem(f).message, /clause 1 .*needs test evidence.*weakest/u);
  tick(f, 'clause 1 [test]: the case passes');
  assert.match(problem(f).message, /clause 3 .*needs screenshot evidence/u);
  tick(f, 'clause 3 [screenshot]: shots/375.png');
  assert.equal(problem(f), null, 'the latest matching tick for each clause stands');
  const loose = fixture(t, '1. Explain design\n2. Explain result');
  tick(loose, 'clause 1 [reasoning]: source argument');
  tick(loose, 'clause 2 [reasoning]: observed outcome');
  assert.match(clauseInspectionSummary(store.getItem(loose.board, loose.id), store.itemThread(loose.board, loose.id)), /2\. .*reasoning \(weakest evidence\)/u);
});

test('a tick by anyone but the holder does not count [V4,B3]', t => {
  const f = fixture(t, THREE);
  store.register(f.board, { lane: 'core', path: '/fixture/other' });
  for (const n of [1, 2, 3]) store.appendFact(f.board, f.id, { agentId: 'core-2', kind: 'note', text: `clause ${n} [test]: forged` });
  assert.match(problem(f).message, /clause 1/u);
});

test('a free-text criterion is unaffected [V4,B3]', t => {
  for (const text of ['the page works and the count is right', 'one numbered line only:\n1. just this', 'out of order\n2. b\n1. a']) {
    const f = fixture(t, text);
    assert.deepEqual(criterionClauses(text), []);
    assert.equal(problem(f), null);
    assert.equal(clauseInspectionSummary(store.getItem(f.board, f.id), store.itemThread(f.board, f.id)), null);
  }
});

test('a real CLI submit refuses an unticked clause and accepts once every clause is ticked [V4,B3]', () => {
  const box = e2e.project();
  const criterion = 'the page is right when:\n1. the heading renders [test]\n2. the footer shows the count [command]\n3. the page is clear at 375px [screenshot]';
  const added = box.run(box.repo, 'add', 'web', 'Clause submit', '--route', 'mid', '--criterion', criterion, '--check', 'true',
    '--brief', 'Files:\n- web/page.html\nTest:\n- the page renders');
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run(box.repo, 'settings', 'inspection.clauses', 'on').code, 0, 'the setting is on for this machine');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>\n', 'feat(web): add page [G1]').status, 0);
  const tick = (n, kind, evidence) => box.run(box.web, 'fact', '1', 'note', `clause ${n} [${kind}]: ${evidence}`);

  const none = box.run(box.web, 'submit', '1');
  assert.notEqual(none.code, 0, 'no clause is ticked');
  assert.match(none.err, /CLAUSE_UNTICKED/u);
  assert.match(none.err, /clause 1 \(the heading renders/u);
  assert.equal(tick(1, 'test', 'test/page.test.js heading case passes').code, 0);
  assert.equal(tick(3, 'screenshot', 'shots/375.png').code, 0);
  const partial = box.run(box.web, 'submit', '1');
  assert.notEqual(partial.code, 0, 'one clause is still unticked');
  assert.match(partial.err, /CLAUSE_UNTICKED/u);
  assert.match(partial.err, /clause 2 \(the footer shows the count/u, 'the unticked clause is named');
  assert.doesNotMatch(partial.err, /clause 1 \(|clause 3 \(/u, 'ticked clauses are not named');
  assert.equal(tick(2, 'screenshot', 'wrong kind despite being ticked').code, 0);
  const mismatch = box.run(box.web, 'submit', '1');
  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.err, /clause 2 .*needs command evidence/u);
  assert.equal(tick(2, 'command', 'node bin/count.js prints 3').code, 0);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err);
  assert.match(submitted.out, /submitted #1/u);
  const shown = box.run(box.web, 'show', '1', '--detail');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /inspection, clause by clause:/u, 'submit records the clause-by-clause evidence for the reviewer');
  assert.match(shown.out, /2\. the footer shows the count.*command: node bin\/count\.js prints 3/u);
});

test('settings prints inspection.clauses only with --detail or once it is on, so the default listing does not grow [V4,B3]', () => {
  const box = e2e.project();
  const line = /^inspection\.clauses: /mu;
  const plain = box.run(box.repo, 'settings');
  assert.equal(plain.code, 0, plain.err);
  assert.doesNotMatch(plain.out, line, 'off by default and not printed');
  const detail = box.run(box.repo, 'settings', '--detail');
  assert.equal(detail.code, 0, detail.err);
  assert.match(detail.out, /^inspection\.clauses: false /mu, '--detail still shows the off setting');
  assert.equal(box.run(box.repo, 'settings', 'inspection.clauses', 'on').code, 0);
  assert.match(box.run(box.repo, 'settings').out, /^inspection\.clauses: true /mu, 'printed once on');
});


test('each declared evidence kind rejects every other kind and accepts a corrected tick [V4,B3]', t => {
  const kinds = ['test', 'command', 'screenshot', 'measurement', 'reasoning'];
  for (const declared of kinds) for (const supplied of kinds) {
    const f = fixture(t, `1. Observe result [${declared}]\n2. Confirm control [test]`);
    tick(f, `clause 1 [${supplied}]: observed evidence`);
    tick(f, 'clause 2 [test]: control passes');
    if (declared === supplied) assert.equal(problem(f), null);
    else {
      assert.equal(problem(f).code, 'CLAUSE_UNTICKED', `${declared} cannot use ${supplied}`);
      assert.match(problem(f).message, new RegExp(`clause 1 .*needs ${declared} evidence`));
      tick(f, `clause 1 [${declared}]: corrected evidence`);
      assert.equal(problem(f), null);
    }
  }
});


test('versioned native submit enforces declared kinds while older engines retain uninspected semantics [V4,H16]', t => {
  const submission = { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40), inspectClauses: true,
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'private inspection transition fixture' } };
  const current = fixture(t, THREE);
  assert.throws(() => store.submit(current.board, current.id, submission), { code: 'CLAUSE_UNTICKED' });
  tick(current, 'clause 1 [screenshot]: not a test');
  tick(current, 'clause 2 [command]: prints 3');
  tick(current, 'clause 3 [screenshot]: shots/375.png');
  assert.throws(() => store.submit(current.board, current.id, submission), /needs test evidence/u);
  tick(current, 'clause 1 [test]: actual case passes');
  store.submit(current.board, current.id, submission);
  assert.equal(store.getItem(current.board, current.id).item_status, 'submitted');
  const older = fixture(t, THREE);
  older.board.executionEngineVersion = CLAUSE_INSPECTION_ENGINE - 1;
  store.submit(older.board, older.id, { ...submission, inspectClauses: undefined });
  assert.equal(store.getItem(older.board, older.id).item_status, 'submitted');
});
