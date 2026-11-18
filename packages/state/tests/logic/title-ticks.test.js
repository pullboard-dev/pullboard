/** With titleTicks on, a [test] clause naming no file is covered by the changed tests holding a case titled "clause N:", and the gate ticks it only when each such case passed (#8879) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateClauseTickNotes } from '../../index.js';
import { gateCoveredFiles } from '../../index.js';

const HEAD = 'd'.repeat(40);
const A = 'apps/cli/tests/io/gate/a.test.js';
const B = 'packages/state/tests/logic/b.test.js';
const OTHER = 'packages/state/tests/logic/other.test.js';
const clause = number => ({ number, kind: 'test', text: 'The same test proves the dry run prints its checklist [test].' });
const item = (extra = {}) => ({ item_id: 9, item_owner: 'seat', item_check: '', item_brief: '', item_criterion: '1. A test shows the checklist prints [test]. 2. The same test proves it is sorted [test].', ...extra });
const gateFiles = new Set([A, B, OTHER]);
const row = (file, name, passed = true, skipped = false) => ({ file, name, passed, skipped });
const cases = [row(A, 'clause 1: the checklist prints'), row(B, 'suite > clause 1: the checklist prints once'), row(A, 'clause 2: it is sorted'), row(OTHER, 'clause 12: unrelated'), row(OTHER, 'no clause here')];

test('state.logic-title-ticks.clause-1-with-titleticks-on: clause 1: with titleTicks on, gateCoveredFiles covers a clause naming no file by the changed tests holding a case titled with its number, and covers nothing with it off [C7]', () => {
  assert.deepEqual(gateCoveredFiles(clause(1), gateFiles, item(), { titleTicks: true, cases }), [A, B]);
  assert.deepEqual(gateCoveredFiles(clause(2), gateFiles, item(), { titleTicks: true, cases }), [A]);
  assert.deepEqual(gateCoveredFiles(clause(3), gateFiles, item(), { titleTicks: true, cases }), [], 'no case titled clause 3; clause 12 does not count');
  assert.deepEqual(gateCoveredFiles(clause(1), new Set([OTHER]), item(), { titleTicks: true, cases }), [], 'only test files the gate ran');
  assert.deepEqual(gateCoveredFiles({ ...clause(1), kind: 'command' }, gateFiles, item(), { titleTicks: true, cases }), [], 'only a [test] clause');
  assert.deepEqual(gateCoveredFiles(clause(1), gateFiles, item(), { cases }), [], 'off by default');
  assert.deepEqual(gateCoveredFiles(clause(1), gateFiles, item(), { titleTicks: false, cases }), []);
});

test('state.logic-title-ticks.clause-2-with-titleticks-on: clause 2: with titleTicks on, gateClauseTickNotes ticks the clause only when every case titled with its number passed in the gate run [C7]', () => {
  const green = [row(A, 'clause 1: the checklist prints'), row(A, 'clause 2: it is sorted')];
  const notes = gateClauseTickNotes(item(), [], { gateFiles, outcomes: green, head: HEAD, titleTicks: true });
  assert.equal(notes.length, 2);
  assert.match(notes[0], new RegExp(`^clause 1 \\[test\\]: gate run of ${A} green at ${HEAD.slice(0, 12)}: 2 cases passed`, 'u'));
  assert.match(notes[1], /^clause 2 \[test\]: gate run of /u);
  const red = [...green, row(B, 'clause 1: the checklist prints once', false)];
  assert.deepEqual(gateClauseTickNotes(item(), [], { gateFiles, outcomes: red, head: HEAD, titleTicks: true }).filter(note => note.startsWith('clause 1 ')), [], 'a failing clause 1 case ticks nothing');
  const skipped = [...green, row(B, 'clause 1: the checklist prints once', false, true)];
  assert.deepEqual(gateClauseTickNotes(item(), [], { gateFiles, outcomes: skipped, head: HEAD, titleTicks: true }).filter(note => note.startsWith('clause 1 ')), [], 'a skipped clause 1 case ticks nothing');
  assert.deepEqual(gateClauseTickNotes(item(), [], { gateFiles, outcomes: green, head: HEAD }), [], 'off ticks nothing');
});
