/** With folderTicks on, a [test] clause naming a folder is covered by the gate-run tests under it, so the gate ticks it (#8846) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseInspectionProblem } from '../../index.js';
import { gateClauseTickNotes } from '../../index.js';
import { gateCoveredFiles } from '../../index.js';

const HEAD = 'b'.repeat(40);
const FILE = 'apps/cli/journeys/bar/dry.test.js';
const clause = { number: 1, kind: 'test', text: 'A new test in apps/cli/journeys/bar proves the dry run prints its checklist [test].' };
const gateFiles = new Set([FILE, 'apps/cli/journeys/barn/other.test.js', 'packages/state/tests/logic/x.test.js']);
const item = (extra = {}) => ({ item_id: 9, item_owner: 'seat', item_check: '', item_brief: '', item_criterion: `1. ${clause.text}`, ...extra });
const green = [{ file: FILE, name: 'clause 1: the dry run prints its checklist', passed: true, skipped: false }];

test('state.logic-folder-ticks.clause-1-with-folderticks-on-a-clause: clause 1: with folderTicks on, a clause quoting a folder is covered by the gate-run tests under that folder only [C7]', () => {
  assert.deepEqual(gateCoveredFiles(clause, gateFiles, item(), { folderTicks: true }), [FILE]);
  assert.deepEqual(gateCoveredFiles({ ...clause, text: 'A new test in `apps/cli/journeys/bar/` proves it [test].' }, gateFiles, item(), { folderTicks: true }), [FILE]);
  assert.deepEqual(gateCoveredFiles({ ...clause, text: 'A new test in apps/cli/journeys/nowhere proves it [test].' }, gateFiles, item(), { folderTicks: true }), []);
  assert.deepEqual(gateCoveredFiles({ ...clause, kind: 'reasoning' }, gateFiles, item(), { folderTicks: true }), []);
  assert.equal(clauseInspectionProblem(item(), [], { gateFiles, head: HEAD, folderTicks: true }), null, 'submit refuses no CLAUSE_UNTICKED');
});

test('state.logic-folder-ticks.clause-1-with-folderticks-off-the: clause 1: with folderTicks off (the default), a folder-named clause is covered by nothing, as before [C7]', () => {
  assert.deepEqual(gateCoveredFiles(clause, gateFiles, item()), []);
  assert.deepEqual(gateCoveredFiles(clause, gateFiles, item(), { folderTicks: false }), []);
  assert.equal(clauseInspectionProblem(item(), [], { gateFiles, head: HEAD })?.code, 'CLAUSE_UNTICKED');
});

test('state.logic-folder-ticks.clause-2-with-folderticks-on-a-green: clause 2: with folderTicks on, a green gate run of the folder\'s tests ticks the clause, and a red or missing one ticks nothing [C7]', () => {
  const notes = gateClauseTickNotes(item(), [], { gateFiles, outcomes: green, head: HEAD, folderTicks: true });
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`^clause 1 \\[test\\]: gate run of ${FILE} green at ${HEAD.slice(0, 12)}: 1 case passed`, 'u'));
  const red = [...green, { file: FILE, name: 'clause 1: a second case', passed: false, skipped: false }];
  assert.deepEqual(gateClauseTickNotes(item(), [], { gateFiles, outcomes: red, head: HEAD, folderTicks: true }), []);
  assert.deepEqual(gateClauseTickNotes(item(), [], { gateFiles, outcomes: [], head: HEAD, folderTicks: true }), []);
  assert.deepEqual(gateClauseTickNotes(item(), [], { gateFiles, outcomes: green, head: HEAD }), [], 'off ticks nothing');
});
