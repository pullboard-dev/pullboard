/** Submit hands the green proof's per-case outcomes to the clause inspection, so a run that skipped every case proves nothing [C7,#10653]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { setAfterGate } from '../../../src/io/board/item/after-gate.js';
import { writeBoardMeta } from '../../../src/io/board/meta.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

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

test('store.io-board-submit.base-rows-read-once: clause 1: a second recordedBaseRows call for the same receipt store reads no receipt file again, and a main-red receipt written after the first call is read once and its rows returned on the next call [C7]', t => {
  const dir = privateFixtureFiles('base-rows-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const BASE = 'c'.repeat(40);
  const rows = [{ file: FILE, name: 'case one', passed: false, skipped: false, failure: 'assertion' }];
  const receipts = {
    '00000000-0000-4000-8000-000000000001': { kind: 'main-red', head: BASE, testOutcomes: rows },
    '00000000-0000-4000-8000-000000000002': { kind: 'main-red', head: 'd'.repeat(40), testOutcomes: [{ file: FILE, name: 'other head', passed: false, skipped: false }] },
    '00000000-0000-4000-8000-000000000003': { kind: 'gate', head: BASE },
  };
  for (const id of Object.keys(receipts)) writeFileSync(join(dir, `${id}.json`), '{}');
  const reads = [];
  const board = { nativePorts: { patchProof: { boardReceiptStore: () => dir, readGateReceipt: (_store, id) => { reads.push(id); return receipts[id] ?? null; } } } };
  assert.deepEqual(store.recordedBaseRows(board, BASE), rows);
  assert.equal(reads.length, 3, 'the first call reads each of the three files once');
  assert.deepEqual(store.recordedBaseRows(board, BASE), rows);
  assert.equal(reads.length, 3, 'the second call reads no file again');
  const later = '00000000-0000-4000-8000-000000000004';
  const laterRows = [{ file: FILE, name: 'case two', passed: false, skipped: false }];
  receipts[later] = { kind: 'main-red', head: BASE, testOutcomes: laterRows };
  writeFileSync(join(dir, `${later}.json`), '{}');
  assert.deepEqual(store.recordedBaseRows(board, BASE), [...rows, ...laterRows]);
  assert.deepEqual(reads.slice(3), [later], 'only the new receipt is read');
  assert.deepEqual(store.recordedBaseRows(board, BASE), [...rows, ...laterRows]);
  assert.equal(reads.length, 4, 'the next call reads nothing');
});

const OLD = 'c'.repeat(40);

/** A submitted dependent behind an after-gate on a parent whose claim recorded `base`, and the parent ready to submit at COMMIT. */
function afterGateFixture(t, base) {
  const board = openKitBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid' });
  const file = name => `test/${name}.test.js`;
  const built = (title, name) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title, criterion: `1. ${file(name)} passes [test]`, specIds: ['C7'], route: 'mid', brief: `Files: src/${name}.js\nTest: ${file(name)} passes` });
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: `after-gate-${name}` }) });
    store.logEvent(board, builder, 'proof-run', id, { receipt: { id: `run-${name}`, kind: 'submit', item: id, commit: COMMIT, tree: TREE, green: true, exitCode: 0,
      testRuntimes: [{ file: file(name) }], testOutcomes: [{ file: file(name), name: 'passes', passed: true, skipped: false }] } });
    return { id, submit: () => store.submit(board, id, { agentId: builder, commit: COMMIT, tree: TREE, files: [], inspectClauses: true,
      submissionProof: { version: 1, files: [file(name)], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } }) };
  };
  const dependent = built('Dependent', 'dependent');
  dependent.submit();
  const parent = built('Parent', 'parent');
  setAfterGate(board, dependent.id, [parent.id]);
  writeBoardMeta(board.db, `after_gate_base:${dependent.id}`, JSON.stringify({ parent: parent.id, head: base }));
  return { board, dependent: dependent.id, submitParent: parent.submit };
}

test('store.io-board-submit.new-parent-head-reopens-dependents: clause 1: resubmitting a parent at a new commit reopens each dependent whose after_gate_base holds the old head, with a note naming both heads [C7,#11808]', t => {
  const f = afterGateFixture(t, OLD);
  assert.equal(store.getItem(f.board, f.dependent).item_status, 'submitted');
  f.submitParent();
  assert.equal(store.getItem(f.board, f.dependent).item_status, 'open', 'the dependent built on the old head goes back');
  const notes = store.events(f.board, { itemId: f.dependent }).filter(row => row.event_detail?.includes(OLD) && row.event_detail.includes(COMMIT));
  assert.ok(notes.length > 0, 'a note names the old head and the new head');
});

test('store.io-board-submit.same-parent-head-leaves-dependents: clause 2: resubmitting a parent at the same commit its dependents were built on leaves every dependent alone [C7,#11808]', t => {
  const f = afterGateFixture(t, COMMIT);
  f.submitParent();
  assert.equal(store.getItem(f.board, f.dependent).item_status, 'submitted', 'the dependent stays submitted');
});
