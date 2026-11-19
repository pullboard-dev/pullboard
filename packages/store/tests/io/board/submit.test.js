/** Submit hands the green proof's per-case outcomes to the clause inspection, so a run that skipped every case proves nothing [C7,#10653]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { fixtureCommittedGraph } from '../../fixtures/cell.js';
import { rmSync } from 'node:fs';
import { checklistEvidenceProblem } from '../../../../state/index.js';
import { carriedClauseTickNotes } from '../../../src/io/board/submit.js';

// fixture-subject: addItem (a store unit test of submit over a seeded item; the board is opened through the kit)

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const FILE = 'test/page.test.js';
const freeze = () => ({ text: '{}', digest: 'synthetic-skipped-run-bar' });

/** A claimed item whose only [test] clause names FILE, with one green proof receipt of COMMIT holding the given outcomes. */
function fixture(t, outcomes) {
  const board = openKitBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Skipped run fixture', criterion: `1. ${FILE} passes [test]`, specIds: ['C7'], route: 'mid', brief: 'Files: src/a.js\nTest: one named case', check: 'true' });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze });
  store.logEvent(board, builder, 'proof-run', id, { receipt: { id: 'run-1', kind: 'submit', item: id, commit: COMMIT, tree: TREE, green: true, exitCode: 0,
    testRuntimes: [{ file: FILE }], testOutcomes: outcomes.map(row => ({ file: FILE, ...row })) } });
  const submit = () => store.submit(board, id, { agentId: builder, commit: COMMIT, tree: TREE, files: [], inspectClauses: true,
    submissionProof: { version: 1, files: [FILE], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  return { board, id, submit };
}

test('store.io-board-submit.a-run-that-skipped-every-case-is-refused: clause 1: submit refuses a clause whose only green run skipped every case, naming the runner and the skipped titles [C7]', t => {
  const f = fixture(t, [{ name: 'renders the page', passed: true, skipped: true, runner: 'runner-7' }]);
  assert.throws(f.submit, error => error.code === 'CLAUSE_UNTICKED' && /every case in test\/page\.test\.js was skipped on runner runner-7: renders the page/u.test(error.message), 'refused naming the runner');
});

test('store.io-board-submit.a-submit-whose-run-skipped-every-case-names-the-runner: clause 2: the refusal on the real submit path lists each skipped case title [C7]', t => {
  const f = fixture(t, [{ name: 'one', passed: true, skipped: true, runner: 'r2' }, { name: 'two', passed: true, skipped: true, runner: 'r2' }]);
  assert.throws(f.submit, error => error.code === 'CLAUSE_UNTICKED' && /r2: one; two/u.test(error.message));
});

test('store.io-board-submit.a-run-with-a-passed-case-still-submits: clause 3: a run with at least one passed case for the clause is accepted as before [C7]', t => {
  const f = fixture(t, [{ name: 'one', passed: true, skipped: true, runner: 'r2' }, { name: 'two', passed: true, skipped: false }]);
  f.submit();
  assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
});

const LOCK = 'tests/lock.test.js';
const LOCK_CASE = 'cli.lock.dead-holder-is-taken-over';

/**
 * A real repository whose head A holds LOCK and whose head B is A plus one more commit, either an unrelated file (as a
 * merge of main adds) or a changed LOCK, and a claimed check-less board item whose only tick is an earlier holder's at A.
 */
function carryFixture(t, { criterion = '1. A dead lock holder is taken over [test]', changeTest = false } = {}) {
  const graph = fixtureCommittedGraph('pullboard-carry-ticks-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put(LOCK, `test('${LOCK_CASE}: clause 1: a dead holder is taken over', () => {});\n`);
  graph.put('src/lock.js', 'export const lock = 1;\n');
  const a = graph.commit();
  if (changeTest) graph.put(LOCK, `test('${LOCK_CASE}: clause 1: a dead holder is taken over', () => { /* weakened */ });\n`);
  else graph.put('src/main.js', 'export const main = 1;\n');
  const b = graph.commit();
  const board = openKitBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const earlier = store.register(board, { lane: 'core', path: '/earlier', route: 'strong' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Carried tick fixture', criterion, specIds: ['C7'], route: 'strong', brief: 'Files: src/lock.js\nTest: tests/lock.test.js' });
  store.claim(board, id, { agentId: earlier, lane: 'core', leaseMs: 3_600_000, freeze });
  store.appendFact(board, id, { agentId: earlier, kind: 'note', text: `clause 1 [${criterion.match(/\[(\w+)\]/u)[1]}]: green pullboard test run of ${LOCK} at ${a.slice(0, 10)}, run 4b4e107e-b818-4421-a9f4-4cf85ac4ca6e: 1 case passed (${LOCK_CASE})` });
  store.release(board, id, earlier, 'fixture hand-off', undefined, 'OTHER');
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze });
  board.gitRoot = graph.root;
  const settle = outcomes => {
    const texts = [];
    store.clauseInspectionNotes(board, id, { gateFiles: new Set([LOCK]), outcomes, head: b, green: true }, text => {
      texts.push(text);
      store.appendFact(board, id, { agentId: builder, kind: 'note', text });
    });
    return texts.filter(text => /^clause \d+ \[\w+\]: gate run of /u.test(text));
  };
  // The carry step alone, as clauseInspectionNotes runs it: its later summary step throws on a clause left with no evidence.
  const carry = outcomes => carriedClauseTickNotes(board, store.getItem(board, id), store.itemThread(board, id), { gateFiles: new Set([LOCK]), outcomes, head: b });
  const problem = () => checklistEvidenceProblem({ ...store.getItem(board, id), item_built_by: builder }, store.itemThread(board, id));
  return { a, b, earlier, settle, carry, problem };
}

const PASSED = [{ file: LOCK, name: `${LOCK_CASE}: clause 1: a dead holder is taken over`, passed: true, skipped: false }];

test('store.io-board-submit.carries-an-unchanged-file-tick: clause 1: a green gate at B carries an earlier holder\'s [test] tick at A when the named test file is unchanged, and the checklist then accepts [C7]', t => {
  const f = carryFixture(t);
  assert.equal(f.problem()?.code, 'CLAUSE_UNTICKED', 'before the settle the earlier holder\'s tick at A does not count');
  // A sharded gate settles with its proof files and no per-case outcomes, so only the earlier tick maps the clause to its file.
  const notes = f.settle([]);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].startsWith(`clause 1 [test]: gate run of ${LOCK} green at ${f.b.slice(0, 12)}`), notes[0]);
  assert.match(notes[0], new RegExp(`carried from ${f.earlier}'s tick at ${f.a.slice(0, 10)}`, 'u'));
  assert.equal(f.problem(), null, 'the carried note is the builder\'s tick at B');
});

test('store.io-board-submit.a-changed-test-file-carries-no-tick: clause 2: a test file changed between A and B, or a failed case in it, carries no tick [C7]', t => {
  const changed = carryFixture(t, { changeTest: true });
  assert.deepEqual(changed.carry(PASSED), [], 'a changed test file carries nothing');
  assert.equal(changed.problem()?.code, 'CLAUSE_UNTICKED');
  const failed = carryFixture(t);
  assert.deepEqual(failed.carry([...PASSED, { file: LOCK, name: `${LOCK_CASE}-2: another case`, passed: false, skipped: false }]), [], 'a failed case carries nothing');
  assert.equal(failed.problem()?.code, 'CLAUSE_UNTICKED');
});

test('store.io-board-submit.command-clauses-never-carry: clause 3: a [command] clause ticked by an earlier holder at A gets no carried note from a green gate at B [C7]', t => {
  const f = carryFixture(t, { criterion: '1. The lock command prints the holder [command]' });
  assert.deepEqual(f.carry(PASSED), []);
  assert.equal(carryFixture(t).carry(PASSED).length, 1, 'the same gate carries the [test] form of the clause');
});
