/** @pullboard-test-input apps/cli/src/io/commands/check.js apps/cli/src/io/test/here.js */
/** @pullboard-world-pin: clause 1 reads the shipped pullboard test command source to prove it records ticks only after a green run. */
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

const RUNNER = 'node packages/gate/src/io/run/tests.js';
const PAIR = { item_id: 9, item_owner: 'core-1', item_criterion: '1. It refuses [test]\n2. It says why [test]',
  item_check: `${RUNNER} test/a.test.js test/b.test.js` };

test('clause 1: a green run covering every check file ticks the clauses; a run of only some of them ticks nothing [C7]', () => {
  assert.equal(testRunTickNotes(PAIR, ['test/a.test.js', './test/b.test.js'], 'abc123').length, 2);
  assert.equal(testRunTickNotes(PAIR, ['test/b.test.js', 'test/a.test.js', 'test/extra.test.js'], 'abc123').length, 2, 'extra green files are fine');
  assert.deepEqual(testRunTickNotes(PAIR, ['test/a.test.js'], 'abc123'), [], 'half the check proves half the bar');
  assert.deepEqual(testRunTickNotes({ ...PAIR, item_check: `${RUNNER} test/a.test.js && false` }, ['test/a.test.js'], 'abc123'), [], 'shell syntax needs pullboard check');
});

test('clause 1: a hand-written note after the green run does not hide it, so submit needs no pullboard check --yes [C7]', () => {
  const notes = testRunTickNotes(PAIR, ['test/a.test.js', 'test/b.test.js'], 'abc123');
  const later = ['clause 1 [test]: test/a.test.js refuses on runner', 'clause 2 [test]: same file says why'];
  assert.equal(clauseInspectionProblem(PAIR, thread([...notes, ...later])), null);
});

test('clause 1: an unticked test clause on a plain test-file check names pullboard test of the check files as the one step [C7]', () => {
  const refused = clauseInspectionProblem(PAIR, thread([]));
  assert.equal(refused.code, 'CLAUSE_UNTICKED');
  assert.equal(refused.next, 'pullboard test test/a.test.js test/b.test.js, then submit again');
  assert.doesNotMatch(refused.message, /pullboard check 9/u);
});
