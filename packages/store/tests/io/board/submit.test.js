/** Submit hands the green proof's per-case outcomes to the clause inspection, so a run that skipped every case proves nothing [C7,#10653]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';

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
