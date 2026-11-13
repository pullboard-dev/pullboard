/** @pullboard-world-pin: the #6810 case reads the committed tree, which must no longer hold the in-process landing batch. */
/** A landing reruns its items' submit proof, never the full plan, and a batch of many lands on its items' receipts [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { landingReceiptReuse } from '../../../index.js';
import { submitProved } from '../../../src/io/step/gate.js';
import { submittedSelections } from '../../../src/io/step/gate.js';

/** #3489's submit on 9 Nov: red only in the relay cases main fails the same way, recorded with gateGreen false. */
function knownMainSubmit(commit) {
  return { commit, gateGreen: false, submissionProof: { version: 1, files: ['apps/cli/journeys/relay/snapshot/size.test.js', 'apps/cli/journeys/relay/main.test.js'], full: false, deferred: true,
    knownMainFailures: { main: 'a'.repeat(40), failures: [{ file: 'apps/cli/journeys/relay/main.test.js', name: 'pairing-cancel', signature: 'b'.repeat(64), item: 3461 }] } } };
}

/** A submit event row as the board stores it. */
function submitRow(detail) {
  return { event_kind: 'submit', event_detail: JSON.stringify(detail) };
}

test('clause 1: a submit admitted on main-owned reds is a proof, so its files plan the landing instead of the full plan [C7]', () => {
  const commit = 'c'.repeat(40);
  assert.equal(submitProved(knownMainSubmit(commit)), true);
  assert.equal(submitProved({ commit, gateGreen: true }), true);
  assert.equal(submitProved({ ...knownMainSubmit(commit), submissionProof: { files: ['apps/cli/journeys/relay/main.test.js'] } }), false, 'red with no main-owned account proves nothing');
  assert.equal(submitProved({ commit }), false);
  const entries = [{ id: 3489, commit }];
  const files = submittedSelections(entries, () => [submitRow(knownMainSubmit(commit))], () => []);
  assert.deepEqual(files, ['apps/cli/journeys/relay/main.test.js', 'apps/cli/journeys/relay/snapshot/size.test.js'], 'the plan is the submit proof, not null (which fell back to the full plan)');
  assert.equal(submittedSelections(entries, () => [submitRow({ ...knownMainSubmit(commit), gateGreen: undefined })], () => []), null);
  assert.equal(submittedSelections([{ id: 3489, commit: 'd'.repeat(40) }], () => [submitRow(knownMainSubmit(commit))], () => []), null, 'another commit\'s submit is not this proof');
});

test('clause 3: a batch of several items lands on their submit receipts, rerunning only each item\'s moved closures and the tests two items reach [C7]', () => {
  // Main at m1 (tree tB); item 7 changed src/a.js, item 8 changed src/b.js, each submitted on m1; the batch composes both.
  const trees = { m1: 'tB' };
  const paths = { 'tB>tA': ['src/a.js'], 'tB>tC': ['src/b.js'], 'tA>tAB': ['src/b.js'], 'tC>tAB': ['src/a.js'], 'tools>tools': [] };
  const changedPaths = (from, to) => from === to ? [] : paths[`${from}>${to}`] ?? null;
  const submit = (commit, tree) => [{ event_kind: 'submit', event_detail: JSON.stringify({ commit, tree, policyCommit: 'm1', tooling: 'tools', gateGreen: true,
    submissionProof: { full: false, deferred: false, files: [] } }) }];
  const events = { 7: submit('c7', 'tA'), 8: submit('c8', 'tC') };
  const reach = { 'test/a.test.js': ['src/a.js'], 'test/b.test.js': ['src/b.js'], 'test/ab.test.js': ['src/a.js', 'src/b.js'], 'test/other.test.js': ['src/z.js'] };
  const closure = { candidates: () => Object.keys(reach), closureChanged: (file, changed) => reach[file].some(path => changed.has(path)) };
  const verdict = landingReceiptReuse({ items: [{ id: 7, commit: 'c7' }, { id: 8, commit: 'c8' }], readEvents: id => events[id], tree: 'tAB', base: 'm1',
    tooling: 'tools', full: false, files: [], treeOf: rev => trees[rev] ?? null, changedPaths, closure });
  assert.equal(verdict.reuse, true, JSON.stringify(verdict));
  assert.deepEqual(verdict.items, [7, 8]);
  assert.deepEqual(verdict.rerun, ['test/ab.test.js'], 'only the test both items reach runs again; each item\'s own tests keep its submit proof');
  // An item whose receipt cannot be read refuses the batch's reuse, naming the item.
  const missing = landingReceiptReuse({ items: [{ id: 7, commit: 'c7' }, { id: 9, commit: 'c9' }], readEvents: id => events[id] ?? [], tree: 'tAB', base: 'm1',
    tooling: 'tools', full: false, files: [], treeOf: rev => trees[rev] ?? null, changedPaths, closure });
  assert.deepEqual([missing.reuse, missing.code, missing.item], [false, 'NO_RECEIPT', 9]);
});

test('#6810 clauses 1-2: the in-process landing batch file is gone and its runner is named nowhere in the tree [C7,#6810]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  assert.equal(existsSync(fileURLToPath(new URL('../../../src/io/in/process.js', import.meta.url))), false);
  // The name is split so this test does not name it; git grep exits 1 when nothing matches.
  const name = 'inProcess' + 'LandingBatch';
  let named = '';
  try { named = execFileSync('git', ['grep', '-l', '-F', name], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  assert.equal(named, '');
});
