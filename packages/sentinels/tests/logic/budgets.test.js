/** A wait item names what it can prove: a board-write contender's recorded holds, or that none overlapped [C7,#11022]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitItemDraft } from '../../src/logic/budgets.js';

const row = recordedHolds => ({ surface: 'board-write', key: '/x/.git/pullboard/board.sqlite:next', holder: 'next by core-7593', pid: 21639, ageMs: 9_600,
  context: 'node apps/cli/pullboard.js next', evidence: '/x/.git/pullboard/board.sqlite.write-holders/21639-a.json', waiters: [],
  budgetName: 'boardWriteMs', budgetMs: 2_000, breach: true, recordedHolds });

test('sentinels.logic-budgets.recorded-holds-in-brief: clause 1: waitItemDraft for a board-write row lists each attached recorded write over budget with its command, seat, heldMs, phase, move and step under Recorded holds [C7,#11022]', () => {
  const draft = waitItemDraft(row([
    { command: 'merged', seat: 'coordinator', item: 4021, pid: 100, heldMs: 7_300, phase: 'native-move', move: 'merged', step: 'rewrite-thread' },
    { command: 'submit', seat: 'core-7', item: null, pid: 101, heldMs: 2_400, phase: 'prepare', move: 'submit', step: null },
  ]));
  const [, section] = draft.brief.split('Recorded holds:');
  assert.match(section, /command merged, seat coordinator, item #4021, heldMs 7300, phase native-move, move merged, step rewrite-thread/u);
  assert.match(section, /command submit, seat core-7, heldMs 2400, phase prepare, move submit, step none/u);
  assert.match(draft.brief, /held or waited 9\.6 s/u, 'a board-write marker may only have waited');
  assert.match(draft.title, /held or waited/u);
  assert.ok(draft.brief.indexOf('Recorded holds:') < draft.brief.indexOf('Files:'), 'the evidence comes before the fix');
});

test('sentinels.logic-budgets.no-recorded-holds-says-waited: clause 1: waitItemDraft for a board-write row with no overlapping recorded write says it waited, and any other surface prints no Recorded holds section [C7,#11022]', () => {
  assert.match(waitItemDraft(row([])).brief, /Recorded holds: none over budget overlap this marker/u);
  const gate = waitItemDraft({ ...row(undefined), surface: 'gate', holder: 'gate:#7', key: 'gate:#7' });
  assert.doesNotMatch(gate.brief, /Recorded holds|held or waited/u);
});
