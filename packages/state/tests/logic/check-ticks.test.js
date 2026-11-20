/** A green gate run of the item check ticks [test] clauses that name no file, so submit needs no prior test run (#6675) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseInspectionProblem } from '../../index.js';
import { checkRunTickNotes } from '../../index.js';
import { gateClauseTickNotes } from '../../index.js';

const HEAD = 'a'.repeat(40);
const FILE = 'web/check.test.mjs';
const item = (criterion, extra = {}) => ({ item_id: 1, item_owner: 'seat', item_check: `node --test ${FILE}`, item_brief: '', item_criterion: criterion, ...extra });
const green = [{ file: FILE, name: 'the count shows', passed: true, skipped: false }];

test('state.logic-check-ticks.clause-1-a-green-gate-run-of-the-item: clause 1: a green gate run of the item check ticks a [test] clause naming no file [C7]', () => {
  const notes = gateClauseTickNotes(item('1. the count shows on a runner [test]'), [], { gateFiles: new Set(), outcomes: green, head: HEAD });
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`^clause 1 \\[test\\]: gate run of ${FILE} green at ${HEAD.slice(0, 12)}: 1 case passed`, 'u'));
});

test('state.logic-check-ticks.clause-1-a-red-check-file-a-skipped-one: clause 1: a red check file, a skipped one and a clause naming its own test file tick nothing from the check [C7]', () => {
  const red = [{ ...green[0], passed: false }];
  assert.deepEqual(gateClauseTickNotes(item('1. the count shows [test]'), [], { gateFiles: new Set(), outcomes: red, head: HEAD }), []);
  assert.deepEqual(gateClauseTickNotes(item('1. the count shows [test]'), [], { gateFiles: new Set(), outcomes: [], head: HEAD }), []);
  assert.deepEqual(gateClauseTickNotes(item('1. other/thing.test.js passes [test]'), [], { gateFiles: new Set(), outcomes: green, head: HEAD }), []);
});

test('state.logic-check-ticks.clause-2-submit-refuses-no-clause-naming: clause 2: submit refuses no [test] clause naming no file, and still names measurement and reasoning clauses [C7]', () => {
  const bar = '1. the count shows [test]\n2. it loads under 2 s [measurement]\n3. the rule is sound [reasoning]';
  const problem = clauseInspectionProblem(item(bar), [], { gateFiles: new Set(), head: HEAD });
  assert.equal(problem?.code, 'CLAUSE_UNTICKED');
  assert.doesNotMatch(problem.message, /clause 1 \(/u);
  assert.match(problem.message, /clause 2 \(/u);
  assert.match(problem.message, /clause 3 \(/u);
  assert.equal(clauseInspectionProblem(item('1. the count shows [test]'), [], { gateFiles: new Set(), head: HEAD }), null);
});

test('state.logic-check-ticks.clause-2-an-item-with-no-test-file-check: clause 2: an item with no test-file check leaves its [test] clause for a fact [C7]', () => {
  const problem = clauseInspectionProblem(item('1. the count shows [test]', { item_check: 'test ! -e src/x.js' }), [], { gateFiles: new Set(), head: HEAD });
  assert.equal(problem?.code, 'CLAUSE_UNTICKED');
});

test('state.logic-check-ticks.command-clause-ticked: clause 1: a green check run ticks each [command] clause with a note citing the check and the head [C7]', () => {
  const notes = checkRunTickNotes(item('1. the count shows [test]\n2. git grep -n thing src/x.js shows it [command]'), HEAD);
  assert.deepEqual(notes, [`clause 1 [test]: green pullboard check run of node --test ${FILE} at ${HEAD}`, `clause 2 [command]: green pullboard check run of node --test ${FILE} at ${HEAD}`]);
});

test('state.logic-check-ticks.measurement-and-reasoning-untouched: clause 2: a check run ticks no [measurement] or [reasoning] clause, and an item with an empty check ticks none [C7]', () => {
  const bar = '1. it loads under 2 s [measurement]\n2. the rule is sound [reasoning]\n3. the file exists [command]';
  assert.deepEqual(checkRunTickNotes(item(bar), HEAD), [`clause 3 [command]: green pullboard check run of node --test ${FILE} at ${HEAD}`]);
  assert.deepEqual(checkRunTickNotes(item(bar, { item_check: '' }), HEAD), []);
});
