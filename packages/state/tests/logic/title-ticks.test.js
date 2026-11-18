/** With titleTicks on, a [test] clause naming no file is covered by the changed tests holding a case titled "clause N:", and the gate ticks it only when each such case passed (#8879) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseCases } from '../../index.js';
import { criterionClauses } from '../../index.js';
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

test('state.logic-title-ticks.clause-cases-by-stable-id-or-own-file: clause 1: clauseCases proves a [test] clause by the stable ID it quotes, or by "clause N:" in its own or "the same" file, never by a same-number case in another file; gateCoveredFiles covers a "same file" clause by that earlier file [C7]', () => {
  const own = 'packages/landing/tests/logic/junit-files.test.js';
  const elsewhere = 'packages/gate/tests/io/summary.test.js';
  const bar = criterionClauses(`1. In ${own}, junitFile maps cmake to cpp [test] 2. In the same file, a row with no classname maps to null [test] 3. Case gate.summary.run-in-common-dir passes on a runner [test]`);
  const ran = [
    row(own, 'landing.junit-files.cmake-reads-the-cpp-row: clause 1: cmake maps to cpp'),
    row(own, 'landing.junit-files.cmake-no-classname: clause 2: no classname is null'),
    row(elsewhere, 'gate.summary.run-in-common-dir: runs in the common dir'),
    row(elsewhere, 'gate.summary.other: clause 1: unrelated'),
  ];
  const names = rows => rows.map(one => one.name);
  assert.deepEqual(names(clauseCases(bar[0], bar, ran)), [ran[0].name], 'clause 1 by its own file, not the other file\'s clause 1 case');
  assert.deepEqual(names(clauseCases(bar[1], bar, ran)), [ran[1].name], '"the same file" is the file clause 1 names');
  assert.deepEqual(names(clauseCases(bar[2], bar, ran)), [ran[2].name], 'by stable ID, with no "clause N" in the title');
  assert.deepEqual(clauseCases(bar[0], bar, [ran[3]]), [], 'a clause 1 case in another file never counts');
  assert.deepEqual(clauseCases(bar[0], bar, [ran[0], row(own, 'landing.junit-files.cmake-fails: clause 1: fails', false)]), [], 'a failing case for the clause blocks it');
  assert.deepEqual(clauseCases(bar[2], bar, [row(elsewhere, 'gate.summary.run-in-common-dir-2: another case')]), [], 'a longer ID is another case');
  assert.deepEqual(clauseCases({ ...bar[0], kind: 'command' }, bar, ran), [], 'only a [test] clause');
  const sameFile = item({ item_criterion: `1. In ${own}, junitFile maps cmake to cpp [test] 2. In the same file, a row with no classname maps to null [test]` });
  assert.deepEqual(gateCoveredFiles(criterionClauses(sameFile.item_criterion)[1], new Set([own, elsewhere]), sameFile), [own], 'the gate ticks clause 2 from the file clause 1 names');
});
