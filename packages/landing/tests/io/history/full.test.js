/** @pullboard-world-pin: the #6810, #6812, #6817 and #6818 cases read the committed tree, which must no longer hold the in-process landing batch, the candidate workers or the scheduler. */
/** A landing reruns its items' submit proof, never the full plan [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitProved } from '../../../src/io/step/gate.js';
import { submittedSelections } from '../../../src/io/step/gate.js';

/** The tracked files under one repository path, as git lists them; empty when none are. */
function tracked(root, path) { return execFileSync('git', ['ls-files', '--', path], { cwd: root, encoding: 'utf8' }); }

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

test('#6810 clauses 1-2: the in-process landing batch file is gone and its runner is named nowhere in the tree [C7,#6810]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  assert.equal(tracked(root, 'packages/landing/src/io/in'), '');
  // The name is split so this test does not name it; git grep exits 1 when nothing matches.
  const name = 'inProcess' + 'LandingBatch';
  let named = '';
  try { named = execFileSync('git', ['grep', '-l', '-F', name], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  assert.equal(named, '');
});

test('#6812 clauses 1-3: candidates.js and step/parallel.js are gone and no file imports either [C7,#6812]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const gone = ['packages/landing/src/io/candidates.js', 'packages/landing/src/io/step/parallel.js'];
  for (const file of gone) assert.equal(tracked(root, file), '', file);
  // git grep reads the committed tree: every relative import naming either basename, resolved against its file.
  let lines = '';
  try { lines = execFileSync('git', ['grep', '-n', '-E', String.raw`(from|import)\s*\(?\s*['"]\.{1,2}/[^'"]*(candidates|parallel)\.js['"]`, '--', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  const importers = [];
  for (const line of lines.split('\n').filter(Boolean)) {
    const file = line.slice(0, line.indexOf(':'));
    for (const [, specifier] of line.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      if (gone.includes(join(dirname(file), specifier))) importers.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(importers, []);
});

test('#6817 clauses 1-2: index.js exports nothing from the scheduler and no source calls its timer, owner or wake [C7,#6817]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  // The scheduler file is gone (#6818), so index.js has nothing of it to export; no source names its four entry points.
  assert.equal(tracked(root, 'packages/landing/src/io/automatic'), '');
  const names = ['scheduleAutomaticLanding', 'resumeAutomaticLanding', 'recoverAutomaticLanding', 'mainLandingWorker'];
  let found = '';
  try { found = execFileSync('git', ['grep', '-l', '-w', ...names.flatMap(name => ['-e', name]), '--', '*.js'], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  const callers = found.split('\n').filter(Boolean).filter(file => !/(^|\/)(tests|journeys)\//u.test(file) && !file.endsWith('.test.js'));
  assert.deepEqual(callers, []);
});

test('#6818 clauses 1-3: the scheduler and its test are gone and no landing source reads or writes its pending record or worker log [C7,#6818]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  assert.equal(tracked(root, 'packages/landing/src/io/automatic/scheduler.js'), '');
  assert.equal(tracked(root, 'packages/landing/tests/io/automatic/scheduler.test.js'), '');
  // Landing source: the landing package and the CLI's landing folder. The names are split so this file does not hold them.
  const files = ['pending' + '.json', 'worker' + '.log'];
  let named = '';
  try { named = execFileSync('git', ['grep', '-n', '-F', ...files.flatMap(file => ['-e', file]), '--', 'packages/landing/src', 'apps/cli/src/io/landing'], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  assert.equal(named, '');
});

test('#6819 clauses 1-2: the train landing module moved into train/ and no file imports its old path [C7,H16,#6819]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  // Built from parts, so this test names no deleted path itself.
  const gone = ['packages/landing/src/io', 'train.js'].join('/');
  assert.equal(tracked(root, gone), '', gone);
  let lines = '';
  try { lines = execFileSync('git', ['grep', '-n', '-E', String.raw`(from|import)\s*\(?\s*['"]\.{1,2}/[^'"]*train\.js['"]`, '--', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  const importers = [];
  for (const line of lines.split('\n').filter(Boolean)) {
    const file = line.slice(0, line.indexOf(':'));
    for (const [, specifier] of line.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      if (join(dirname(file), specifier) === gone) importers.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(importers, []);
});

test('#6814 clauses 1-2: the landing receipt reuse path is gone from reuse.js and named nowhere in the tree [C7,#6814]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  // The name is split so this test does not name it; git grep exits 1 when nothing matches.
  const name = 'landingReceipt' + 'Reuse';
  let named = '';
  try { named = execFileSync('git', ['grep', '-l', '-F', name], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  assert.equal(named, '');
});

test('#6815 clauses 1-2: the batch gate\'s unit reuse and trunk-move reruns are gone from step/gate.js and named nowhere in the tree [C7,#6815]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  // The names are split so this test does not name them; git grep exits 1 when nothing matches.
  for (const name of ['submitted' + 'Units', 'trunkMove' + 'Reruns', 'interacting' + 'Tests']) {
    let named = '';
    try { named = execFileSync('git', ['grep', '-l', '-w', '-F', name], { cwd: root, encoding: 'utf8' }); }
    catch (error) { if (error.status !== 1) throw error; }
    assert.equal(named, '', name);
  }
});
