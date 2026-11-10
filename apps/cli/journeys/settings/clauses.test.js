import { CLAUSE_INSPECTION_ENGINE } from '../../../../packages/state/light.js';
/** Prove clause inspection: an unticked clause refuses submit and is named, free text is unaffected [#2050]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyEngineMove,
  appliedSequence,
} from '../../../../packages/state/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { clauseInspectionProblem } from '../../../../packages/state/index.js';
import { clauseInspectionSummary } from '../../../../packages/state/index.js';
import { criterionClauses } from '../../../../packages/state/index.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

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
const problem = ({ board, id }, options = undefined) => clauseInspectionProblem(store.getItem(board, id), store.itemThread(board, id), options);
const tick = ({ board, id }, text) => store.appendFact(board, id, { agentId: 'core-1', kind: 'note', text });

test('inspection policy is a board setting that defaults on and validates booleans [V4,B3,C7]', () => {
  assert.equal(configFromSource('{}').verify.inspectClauses, true);
  assert.equal(configFromSource('{"verify":{"inspectClauses":true}}').verify.inspectClauses, true);
  assert.throws(() => configFromSource('{"verify":{"inspectClauses":"on"}}'), /verify\.inspectClauses/u);
});

test('a three-clause criterion refuses submit with one unticked and names it, then accepts when all carry evidence [V4,B3]', t => {
  const f = fixture(t, THREE);
  assert.equal(criterionClauses(THREE).length, 3);
  assert.match(problem(f).message, /clause 1 .*no evidence.*clause 2 .*no evidence.*clause 3 .*no evidence/u);
  tick(f, 'clause 1 [test]: test/list.test.js "clause 1: renders" passes');
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

test('single and inline numbered clauses retain their shared checklist numbers [V4,B3]', () => {
  assert.deepEqual(criterionClauses('1) One measurable outcome [test]'), [
    { number: 1, text: 'One measurable outcome [test]', kind: 'test' },
  ]);
  assert.deepEqual(criterionClauses('Complete when: 1) the list renders [test]; 2) the count is 3 [command]'), [
    { number: 1, text: 'the list renders [test]', kind: 'test' },
    { number: 2, text: 'the count is 3 [command]', kind: 'command' },
  ]);
});

test('test evidence must name the clause its case covers [V4,B3]', t => {
  const f = fixture(t, '1. The outcome is verified [test]');
  tick(f, 'clause 1 [test]: test/page.test.js the page renders');
  assert.match(problem(f).message, /needs a named test case citing clause 1/u);
  tick(f, 'clause 1 [test]: test/page.test.js "clause 1: page renders" passes');
  assert.equal(problem(f), null);
});

test('reasoning is flagged weakest and cannot stand in for a declared test or command [V4,B3]', t => {
  const f = fixture(t, THREE);
  tick(f, 'clause 1 [reasoning]: it obviously renders');
  tick(f, 'clause 2 [command]: prints 3');
  tick(f, 'clause 3 [reasoning]: looks fine');
  assert.match(problem(f).message, /clause 1 .*needs test evidence.*weakest/u);
  tick(f, 'clause 1 [test]: case named clause 1 passes');
  assert.match(problem(f).message, /clause 3 .*needs screenshot evidence/u);
  tick(f, 'clause 3 [screenshot]: shots/375.png');
  assert.equal(problem(f), null, 'the latest matching tick for each clause stands');
  const loose = fixture(t, '1. Explain design [reasoning]\n2. Explain result [reasoning]');
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
  for (const text of ['the page works and the count is right', 'out of order\n2. b\n1. a']) {
    const f = fixture(t, text);
    assert.deepEqual(criterionClauses(text), []);
    assert.equal(problem(f), null);
    assert.equal(clauseInspectionSummary(store.getItem(f.board, f.id), store.itemThread(f.board, f.id)), null);
  }
});

test('a real CLI submit refuses an unticked clause and accepts once every clause is ticked [V4,B3]', () => {
  const box = e2e.project();
  const criterion = 'the page is right when:\n1. the heading renders [test]\n2. the footer shows the count [command]\n3. the page is clear at 375px [screenshot]';
  const added = fixtureAdd(box.run, box.repo, 'web', 'Clause submit', '--route', 'mid', '--criterion', criterion, '--check', 'true',
    '--brief', 'Files:\n- web/page.html\nTest:\n- the page renders');
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>\n', 'feat(web): add page [G1]').status, 0);
  const tick = (n, kind, evidence) => box.run(box.web, 'fact', '1', 'note', `clause ${n} [${kind}]: ${evidence}`);

  const none = box.run(box.web, 'submit', '1');
  assert.notEqual(none.code, 0, 'no clause is ticked');
  assert.match(none.err, /CLAUSE_UNTICKED/u);
  assert.match(none.err, /clause 1 \(the heading renders/u);
  assert.equal(tick(1, 'test', 'test/page.test.js "clause 1: heading renders" passes').code, 0);
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
  assert.match(detail.out, /^inspection\.clauses: false .*legacy machine value; submit uses verify\.inspectClauses from accepted main/mu);
  assert.equal(box.run(box.repo, 'settings', 'inspection.clauses', 'on').code, 0);
  assert.match(box.run(box.repo, 'settings').out, /^inspection\.clauses: true .*legacy machine value; submit uses verify\.inspectClauses from accepted main/mu);
});


test('each declared evidence kind rejects every other kind and accepts a corrected tick [V4,B3]', t => {
  const kinds = ['test', 'command', 'screenshot', 'measurement', 'reasoning'];
  for (const declared of kinds) for (const supplied of kinds) {
    const f = fixture(t, `1. Observe result [${declared}]\n2. Confirm control [test]`);
    tick(f, `clause 1 [${supplied}]: ${supplied === 'test' ? 'case named clause 1 passes' : 'observed evidence'}`);
    tick(f, 'clause 2 [test]: case named clause 2 passes');
    if (declared === supplied) assert.equal(problem(f), null);
    else {
      assert.equal(problem(f).code, 'CLAUSE_UNTICKED', `${declared} cannot use ${supplied}`);
      assert.match(problem(f).message, new RegExp(`clause 1 .*needs ${declared} evidence`));
      tick(f, `clause 1 [${declared}]: ${declared === 'test' ? 'case named clause 1 passes' : 'corrected evidence'}`);
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
  tick(current, 'clause 1 [test]: case named clause 1 passes');
  store.submit(current.board, current.id, submission);
  assert.equal(store.getItem(current.board, current.id).item_status, 'submitted');
  const older = fixture(t, THREE);
  older.board.executionEngineVersion = CLAUSE_INSPECTION_ENGINE - 1;
  store.submit(older.board, older.id, { ...submission, inspectClauses: undefined });
  assert.equal(store.getItem(older.board, older.id).item_status, 'submitted');
});


test('accepted board policy overrides a false caller flag at the store and move boundary [V4,H16]', t => {
  const f = fixture(t, THREE);
  const main = 'c'.repeat(40);
  f.board.gitRoot = '/fixture/policy';
  const reads = { ...f.board.enginePorts.sandboxPolicyReads,
    mainPolicy: () => ({ commit: main, config: { verify: { inspectClauses: true } } }),
    policyAt: (_root, commit) => ({ commit, config: { verify: { inspectClauses: true } } }) };
  f.board.enginePorts = { ...f.board.enginePorts, sandboxPolicyReads: reads };
  const options = { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    policyCommit: main, inspectClauses: false,
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'private policy test' } };
  assert.throws(() => store.submit(f.board, f.id, options), { code: 'CLAUSE_UNTICKED' });
  const move = prepareEngineMove(f.board, 'submit', [f.id, options], { id: 'clause-policy-sealed' });
  assert.equal(move.args[1].inspectClauses, true);
  assert.equal(move.args[1].clausePolicyCommit, main);
  const policyAt = reads.policyAt;
  reads.policyAt = () => { throw new Error('missing immutable policy'); };
  assert.throws(() => applyEngineMove(f.board, move, { sequence: 1, at: new Date().toISOString() }), /missing immutable policy/u);
  assert.equal(appliedSequence(f.board), 0, 'missing Git data cannot consume a relay position');
  reads.policyAt = policyAt;
  reads.mainPolicy = () => ({ commit: 'd'.repeat(40), config: { verify: { inspectClauses: false } } });
  const result = applyEngineMove(f.board, move, { sequence: 1, at: new Date().toISOString() });
  assert.equal(result.error?.code, 'CLAUSE_UNTICKED');
  assert.equal(store.getItem(f.board, f.id).item_status, 'claimed');
});

test('a test tick naming a file the commit\'s green proof ran is proven without the clause number in the case name [C7]', t => {
  const f = fixture(t, '1. The outcome is verified [test]');
  tick(f, 'clause 1 [test]: test/page.test.js the page renders');
  assert.match(problem(f).message, /needs a named test case citing clause 1/u, 'no proof yet');
  assert.equal(problem(f, { greenFiles: new Set(['test/page.test.js']) }), null, 'the green proof of this commit ran that file');
  assert.match(problem(f, { greenFiles: new Set(['test/other.test.js']) }).message, /citing clause 1/u, 'another file proves nothing for it');
});

test('clause 1: an unticked [test] clause on an item with a frozen check is refused with pullboard check <id> as the step and the next line [C7]', t => {
  const f = fixture(t, 'the bar is met when:\n1. the list renders [test]\n2. the count shows 3 [command]');
  const refused = problem(f);
  assert.equal(refused.code, 'CLAUSE_UNTICKED');
  assert.match(refused.message, new RegExp(`run pullboard check ${f.id}, which runs the frozen check and ticks every test clause`, 'u'));
  assert.equal(refused.next, `pullboard check ${f.id}, then submit again`);
  tick(f, 'clause 1 [test]: green pullboard check run of true at abc');
  assert.equal(problem(f).next, undefined, 'a command clause alone keeps the plain tick step');
});

test('clause 2: an unticked [test] clause on an item with no check is refused with pullboard test <file> on the file the clause names [C7]', t => {
  const f = fixture(t, 'the bar is met when:\n1. test/page.test.js passes [test]');
  // A mid item cannot be filed without a check, so the same item is read with its check cleared.
  const refused = clauseInspectionProblem({ ...store.getItem(f.board, f.id), item_check: '' }, store.itemThread(f.board, f.id));
  assert.equal(refused.code, 'CLAUSE_UNTICKED');
  assert.match(refused.message, /run pullboard test test\/page\.test\.js, then tick the clause with its green run/u);
  assert.equal(refused.next, 'pullboard test test/page.test.js, then tick the clause and submit again');
});
