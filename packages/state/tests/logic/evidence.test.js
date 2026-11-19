/** @pullboard-test-input apps/cli/src/io/commands/check.js apps/cli/src/io/test/here.js */
/** @pullboard-world-pin: clause 1 reads the shipped pullboard test run source to prove it records ticks only after a green run. */
/** A green pullboard test run of the item's check ticks the test clauses it proves [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkRunTickNotes } from '../../index.js';
import { checklistEvidenceProblem } from '../../index.js';
import { clauseInspectionProblem } from '../../index.js';
import { guardBar } from '../../index.js';
import { requireCriterionEvidence } from '../../index.js';
import { testRunTickNotes } from '../../index.js';

const FILE = 'test/example.test.js';
const item = {
  item_id: 7, item_owner: 'core-1',
  item_criterion: '1) The heading is present [test]\n2) It fits at 375px [screenshot]\n3) The count appears [test]',
  item_check: `node apps/cli/pullboard.js test ${FILE}`,
};

/** The thread entries a builder's notes become. */
function thread(texts) {
  return texts.map((text, index) => ({ type: 'fact', kind: 'note', by: 'core-1', text, id: `f${index}` }));
}

test('state.logic-evidence.clause-1-a-green-check-run-ticks-its: clause 1: a green check run ticks its clauses [C7]', () => {
  const notes = testRunTickNotes(item, [FILE], 'abc123');
  assert.equal(notes.length, 2, 'only the two [test] clauses are ticked');
  assert.match(notes[0], /^clause 1 \[test\]: green pullboard test run of test\/example\.test\.js at abc123$/u);
  assert.match(notes[1], /^clause 3 \[test\]:/u);
  const testOnly = { ...item, item_criterion: '1) test/c.test.js: The heading is present [test]\n2) test/c.test.js: The count appears [test]' };
  const problem = clauseInspectionProblem(testOnly, thread(testRunTickNotes(testOnly, [FILE], 'abc123')));
  assert.equal(problem, null, 'submit does not refuse CLAUSE_UNTICKED after the run notes');
  const other = clauseInspectionProblem(item, thread(notes));
  assert.match(other.message, /clause 2/u, 'a non-test clause still needs its own evidence');
});

test('state.logic-evidence.clause-1-a-run-of-a-file-outside-the: clause 1: a run of a file outside the check ticks nothing [C7]', () => {
  assert.deepEqual(testRunTickNotes(item, ['test/other.test.js'], 'abc123'), []);
  assert.deepEqual(testRunTickNotes(item, [], 'abc123'), []);
});

test('state.logic-evidence.clause-1-pullboard-test-records-the: clause 1: pullboard test records the ticks only after a green run [C7]', () => {
  const source = readFileSync(new URL('../../../../apps/cli/src/io/test/here.js', import.meta.url), 'utf8');
  assert.match(source, /result\.green && item !== undefined\) await (?:recordAgainstMain\(\(\) => )?recordClauseTicks\(/u);
});

test('state.logic-evidence.clause-1-a-green-run-of-a-shell-command: clause 1: a green run of a shell-command check ticks its clauses [C7]', () => {
  const shell = { ...item, item_criterion: '1) The old file is gone [test]\n2) The new file exists [test]', item_check: 'test ! -e src/x.js' };
  const notes = checkRunTickNotes(shell, 'abc123');
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^clause 1 \[test\]: green pullboard check run of test ! -e src\/x\.js at abc123$/u);
  assert.equal(clauseInspectionProblem(shell, thread(notes)), null, 'submit does not refuse CLAUSE_UNTICKED after a green shell check');
  assert.deepEqual(checkRunTickNotes({ ...shell, item_check: '' }, 'abc123'), []);
});

test('state.logic-evidence.clause-1-pullboard-check-records-the: clause 1: pullboard check records the ticks only after a green run [C7]', () => {
  const source = readFileSync(new URL('../../../../apps/cli/src/io/commands/check.js', import.meta.url), 'utf8');
  assert.match(source, /run\.isGreen\) await recordCheckTicks/u);
});

const RUNNER = 'node packages/gate/src/io/run/tests.js';
const PAIR = { item_id: 9, item_owner: 'core-1', item_criterion: '1. It refuses [test]\n2. It says why [test]',
  item_check: `${RUNNER} test/a.test.js test/b.test.js` };

test('state.logic-evidence.clause-1-a-green-run-covering-every: clause 1: a green run covering every check file ticks the clauses; a run of only some of them ticks nothing [C7]', () => {
  assert.equal(testRunTickNotes(PAIR, ['test/a.test.js', './test/b.test.js'], 'abc123').length, 2);
  assert.equal(testRunTickNotes(PAIR, ['test/b.test.js', 'test/a.test.js', 'test/extra.test.js'], 'abc123').length, 2, 'extra green files are fine');
  assert.deepEqual(testRunTickNotes(PAIR, ['test/a.test.js'], 'abc123'), [], 'half the check proves half the bar');
  assert.deepEqual(testRunTickNotes({ ...PAIR, item_check: `${RUNNER} test/a.test.js && false` }, ['test/a.test.js'], 'abc123'), [], 'shell syntax needs pullboard check');
});

test('state.logic-evidence.clause-1-a-hand-written-note-after-the: clause 1: a hand-written note after the green run does not hide it, so submit needs no pullboard check --yes [C7]', () => {
  const notes = testRunTickNotes(PAIR, ['test/a.test.js', 'test/b.test.js'], 'abc123');
  const later = ['clause 1 [test]: test/a.test.js refuses on runner', 'clause 2 [test]: same file says why'];
  assert.equal(clauseInspectionProblem(PAIR, thread([...notes, ...later])), null);
});

test('state.logic-evidence.clause-1-an-unticked-test-clause-naming: clause 1: an unticked test clause naming a test file the gate does not run names pullboard test of the check files as the one step [C7]', () => {
  const refused = clauseInspectionProblem({ ...PAIR, item_criterion: '1. test/c.test.js refuses [test]\n2. test/c.test.js says why [test]' }, thread([]));
  assert.equal(refused.code, 'CLAUSE_UNTICKED');
  assert.equal(refused.next, 'pullboard test test/a.test.js test/b.test.js, then submit again');
  assert.doesNotMatch(refused.message, /pullboard check 9/u);
});

const HEAD = '86ac47390cbf9d2d37ef9e83af946c5767d1f31d';
const bar = { ...item, item_owner: 'core-2', item_criterion: '1) test/c.test.js: The heading is present [test]\n2) test/c.test.js: The count appears [test]' };
const earlier = thread(testRunTickNotes(bar, [FILE], HEAD));

test('state.logic-evidence.clause-1-a-re-claim-of-the-same-bar-at: clause 1: a re-claim of the same bar at the same head keeps the earlier holder\'s ticks [C7]', () => {
  assert.equal(clauseInspectionProblem(bar, earlier, { head: HEAD }), null, 'ticks citing the unchanged head still count');
  assert.equal(clauseInspectionProblem(bar, earlier, { head: HEAD.slice(0, 12) }), null, 'a short head matches too');
  const merge = { type: 'fact', kind: 'note', by: 'core-2', text: `Builder core-2 automatic main merge: source ${HEAD}, main ${'1'.repeat(40)}, merge ${'e'.repeat(40)}.` };
  assert.equal(clauseInspectionProblem(bar, [...earlier, merge], { head: 'e'.repeat(40) }), null, 'the merge of that head onto main counts as it');
  assert.match(clauseInspectionProblem(bar, earlier, { head: 'f'.repeat(40) }).message, /clause 1 .*no evidence/u, 'a new head re-proves');
  assert.match(clauseInspectionProblem(bar, earlier).message, /clause 2 .*no evidence/u, 'without a head the earlier ticks do not count');
});

test('state.logic-evidence.clause-2-ticks-recorded-before-the-bar: clause 2: ticks recorded before the bar text changed do not count [C7]', () => {
  const edit = criterion => ({ type: 'move', kind: 'edit', by: 'coordinator', detail: { criterion } });
  const changed = [...earlier, edit(bar.item_criterion.replace('count', 'total'))];
  const sharpened = { ...bar, item_criterion: bar.item_criterion.replace('count', 'total') };
  assert.match(clauseInspectionProblem(sharpened, changed, { head: HEAD }).message, /clause 1 .*no evidence/u, 'an earlier holder\'s ticks lapse');
  const own = { ...sharpened, item_owner: 'core-1' };
  assert.match(clauseInspectionProblem(own, changed, { head: HEAD }).message, /clause 1 .*no evidence/u, 'the holder\'s own ticks lapse too');
  const restated = [edit(bar.item_criterion), ...earlier];
  assert.equal(clauseInspectionProblem(bar, restated, { head: HEAD }), null, 'ticks under the current text still count');
});

test('state.logic-evidence.run-cases-tick-a-checkless-bar: clause 2: a green run ticks each [test] clause of a bar with no check that its cases prove, citing the run id, head and case titles, never from a same-number case in another file, and accept and submit read those notes [C7]', () => {
  const own = 'packages/landing/tests/logic/junit-files.test.js';
  const other = 'packages/gate/tests/io/other.test.js';
  const checkless = { item_id: 10589, item_owner: 'core-1', item_check: '', item_criterion: `1. In ${own}, cmake maps to cpp [test] 2. In the same file, no classname is null [test] 3. Case landing.junit-files.registered passes [test]` };
  const pass = (file, name) => ({ file, name, passed: true, skipped: false });
  const rows = [pass(own, 'landing.junit-files.cmake-row: clause 1: cmake maps to cpp'), pass(other, 'gate.other.x: clause 2: unrelated'), pass(own, 'landing.junit-files.registered: titles carry IDs')];
  const run = '9278348d-5ba7-47db-bea6-9af90a095bf0';
  const notes = testRunTickNotes(checkless, [own, other], HEAD, { outcomes: rows, run });
  assert.deepEqual(notes.map(note => note.slice(0, 9)), ['clause 1 ', 'clause 3 '], 'clause 2 has only a same-number case in another file');
  assert.equal(notes[0], `clause 1 [test]: green pullboard test run of ${own} at ${HEAD}, run ${run}: 1 case passed (landing.junit-files.cmake-row: clause 1: cmake maps to cpp)`);
  assert.match(checklistEvidenceProblem(checkless, thread(notes)).message, /clause 2 .*has no evidence/u, 'accept still names the unproven clause');
  const all = testRunTickNotes(checkless, [own], HEAD, { outcomes: [...rows, pass(own, 'landing.junit-files.null-row: clause 2: no classname is null')], run });
  assert.equal(all.length, 3);
  assert.equal(checklistEvidenceProblem(checkless, thread(all)), null, 'accept reads the notes as checklist evidence');
  assert.equal(clauseInspectionProblem(checkless, thread(all), { head: HEAD }), null, 'submit reads them as ticks');
  assert.deepEqual(testRunTickNotes(checkless, [own], HEAD), [], 'a run with no outcome rows ticks nothing');
  assert.equal(testRunTickNotes(PAIR, ['test/a.test.js', 'test/b.test.js'], HEAD, { outcomes: rows, run }).length, 2, 'a bar with check files keeps its check-file ticks');
});

test('state.logic-evidence.refuse-empty-bar-on: clause 1: guardBar with refuseEmpty refuses a missing, blank or unnumbered bar BAR_EMPTY with the edit --criterion step [C7]', () => {
  for (const bar of [undefined, '', '   \n', 'make it faster']) {
    assert.throws(() => guardBar(bar, { refuseEmpty: true }), error => error.code === 'BAR_EMPTY' && /edit <id> --criterion/u.test(error.next ?? error.message), `refused: ${JSON.stringify(bar)}`);
  }
  assert.deepEqual(guardBar('1. It prints the heading [test]', { refuseEmpty: true }), [], 'a numbered bar passes');
});

test('state.logic-evidence.refuse-empty-bar-off: clause 2: guardBar without refuseEmpty returns no warnings for an undefined bar, as before [C7]', () => {
  assert.deepEqual(guardBar(undefined), []);
  assert.deepEqual(guardBar(undefined, {}), []);
  assert.deepEqual(guardBar(undefined, { refuseEmpty: false }), []);
});

test('state.logic-evidence.all-faults-at-once: clause 1: requireCriterionEvidence on a bar with one untagged clause and one measurement clause with no number refuses once, naming both clause numbers [C7,#12015]', () => {
  const bar = '1. The page loads quickly\n2. The load stays fast [measurement]';
  assert.throws(() => requireCriterionEvidence(bar), error => error.code === 'CLAUSE_EVIDENCE_REQUIRED'
    && /clause 1 has no evidence kind/u.test(error.message) && /clause 2 is a \[measurement\] with no number/u.test(error.message));
});

test('state.logic-evidence.next-carries-the-fix: clause 2: that refusal next line says to end the untagged clause with one of the evidence tags and to put a number in the measurement clause, and never says ask the service owner [C7,#12015]', () => {
  const bar = '1. The page loads quickly\n2. The load stays fast [measurement]';
  assert.throws(() => requireCriterionEvidence(bar), error => /clause 1: end it with one of \[test\|command/u.test(error.next)
    && /clause 2: put the number it must meet in the clause/u.test(error.next) && !/service owner/u.test(`${error.message} ${error.next}`));
});

test('state.logic-evidence.guard-bar-lists-all-faults: clause 1: guardBar on a bar with one untagged clause and one measurement clause with no number refuses once, naming both clauses and both fixes [C7,#12015]', () => {
  const bar = '1. The page loads quickly\n2. The load stays fast [measurement]';
  assert.throws(() => guardBar(bar), error => /clause 1 has no evidence kind/u.test(error.message) && /clause 2 is a \[measurement\] with no number/u.test(error.message)
    && /clause 1: end it with one of/u.test(error.next) && /clause 2: put the number it must meet/u.test(error.next) && !/service owner/u.test(`${error.message} ${error.next}`));
  assert.throws(() => guardBar('1. It loads [test]\n2. The load stays fast [measurement]'), error => error.code === 'BAR_AMBIGUOUS' && /put the number in clause 2/u.test(error.next));
});
