/** @pullboard-test-input source-tree */
/** A green pullboard test run of the item's check ticks the test clauses it proves [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { clauseInspectionProblem, testRunTickNotes } from '../packages/state/index.js';

const FILE = 'test/example.test.js';
const item = {
  item_id: 7, item_owner: 'core-1',
  item_criterion: '1) The heading is present [test]\n2) It fits at 375px [screenshot]\n3) The count appears [test]',
  item_check: `node bin/pullboard.js test ${FILE}`,
};

/** The thread entries a builder's notes become. */
function thread(texts) {
  return texts.map((text, index) => ({ type: 'fact', kind: 'note', by: 'core-1', text, id: `f${index}` }));
}

test('clause 1: a green check run ticks its clauses', () => {
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

test('clause 1: a run of a file outside the check ticks nothing', () => {
  assert.deepEqual(testRunTickNotes(item, ['test/other.test.js'], 'abc123'), []);
  assert.deepEqual(testRunTickNotes(item, [], 'abc123'), []);
});

test('clause 1: pullboard test records the ticks only after a green run', () => {
  const source = readFileSync(new URL('../apps/cli/src/shell/commands/test.js', import.meta.url), 'utf8');
  assert.match(source, /result\.green && item !== undefined\) await recordClauseTicks/u);
});
