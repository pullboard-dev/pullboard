/** @pullboard-test-input apps/cli/src/io/commands/check.js apps/cli/src/io/test/here.js */
/** @pullboard-world-pin: clause 1 reads the shipped pullboard test run source to prove it records ticks only after a green run. */
/** A green pullboard test run of the item's check ticks the test clauses it proves [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkRunTickNotes } from '../../index.js';
import { clauseInspectionProblem } from '../../index.js';
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

test('clause 1: a green check run ticks its clauses [C7]', () => {
  const notes = testRunTickNotes(item, [FILE], 'abc123');
  assert.equal(notes.length, 2, 'only the two [test] clauses are ticked');
  assert.match(notes[0], /^clause 1 \[test\]: green pullboard test run of test\/example\.test\.js at abc123$/u);
  assert.match(notes[1], /^clause 3 \[test\]:/u);
  const testOnly = { ...item, item_criterion: '1) The heading is present [test]\n2) The count appears [test]' };
  const problem = clauseInspectionProblem(testOnly, thread(testRunTickNotes(testOnly, [FILE], 'abc123')));
  assert.equal(problem, null, 'submit does not refuse CLAUSE_UNTICKED after the run notes');
  const other = clauseInspectionProblem(item, thread(notes));
  assert.match(other.message, /clause 2/u, 'a non-test clause still needs its own evidence');
});

test('clause 1: a run of a file outside the check ticks nothing [C7]', () => {
  assert.deepEqual(testRunTickNotes(item, ['test/other.test.js'], 'abc123'), []);
  assert.deepEqual(testRunTickNotes(item, [], 'abc123'), []);
});

test('clause 1: pullboard test records the ticks only after a green run [C7]', () => {
  const source = readFileSync(new URL('../../../../apps/cli/src/io/test/here.js', import.meta.url), 'utf8');
  assert.match(source, /result\.green && item !== undefined\) await recordClauseTicks/u);
});

test('clause 1: a green run of a shell-command check ticks its clauses [C7]', () => {
  const shell = { ...item, item_criterion: '1) The old file is gone [test]\n2) The new file exists [test]', item_check: 'test ! -e src/x.js' };
  const notes = checkRunTickNotes(shell, 'abc123');
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^clause 1 \[test\]: green pullboard check run of test ! -e src\/x\.js at abc123$/u);
  assert.equal(clauseInspectionProblem(shell, thread(notes)), null, 'submit does not refuse CLAUSE_UNTICKED after a green shell check');
  assert.deepEqual(checkRunTickNotes({ ...shell, item_check: '' }, 'abc123'), []);
});

test('clause 1: pullboard check records the ticks only after a green run [C7]', () => {
  const source = readFileSync(new URL('../../../../apps/cli/src/io/commands/check.js', import.meta.url), 'utf8');
  assert.match(source, /run\.isGreen\) await recordCheckTicks/u);
});

const HEAD = '86ac47390cbf9d2d37ef9e83af946c5767d1f31d';
const bar = { ...item, item_owner: 'core-2', item_criterion: '1) The heading is present [test]\n2) The count appears [test]' };
const earlier = thread(testRunTickNotes(bar, [FILE], HEAD));

test('clause 1: a re-claim of the same bar at the same head keeps the earlier holder\'s ticks [C7]', () => {
  assert.equal(clauseInspectionProblem(bar, earlier, { head: HEAD }), null, 'ticks citing the unchanged head still count');
  assert.equal(clauseInspectionProblem(bar, earlier, { head: HEAD.slice(0, 12) }), null, 'a short head matches too');
  const merge = { type: 'fact', kind: 'note', by: 'core-2', text: `Builder core-2 automatic main merge: source ${HEAD}, main ${'1'.repeat(40)}, merge ${'e'.repeat(40)}.` };
  assert.equal(clauseInspectionProblem(bar, [...earlier, merge], { head: 'e'.repeat(40) }), null, 'the merge of that head onto main counts as it');
  assert.match(clauseInspectionProblem(bar, earlier, { head: 'f'.repeat(40) }).message, /clause 1 .*no evidence/u, 'a new head re-proves');
  assert.match(clauseInspectionProblem(bar, earlier).message, /clause 2 .*no evidence/u, 'without a head the earlier ticks do not count');
});

test('clause 2: ticks recorded before the bar text changed do not count [C7]', () => {
  const edit = criterion => ({ type: 'move', kind: 'edit', by: 'coordinator', detail: { criterion } });
  const changed = [...earlier, edit(bar.item_criterion.replace('count', 'total'))];
  const sharpened = { ...bar, item_criterion: bar.item_criterion.replace('count', 'total') };
  assert.match(clauseInspectionProblem(sharpened, changed, { head: HEAD }).message, /clause 1 .*no evidence/u, 'an earlier holder\'s ticks lapse');
  const own = { ...sharpened, item_owner: 'core-1' };
  assert.match(clauseInspectionProblem(own, changed, { head: HEAD }).message, /clause 1 .*no evidence/u, 'the holder\'s own ticks lapse too');
  const restated = [edit(bar.item_criterion), ...earlier];
  assert.equal(clauseInspectionProblem(bar, restated, { head: HEAD }), null, 'ticks under the current text still count');
});
