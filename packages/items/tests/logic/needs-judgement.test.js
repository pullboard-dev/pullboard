/** Wall and decision items go to a needs-judgement list with their stop reason and attempts [C7,#2220]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsJudgement } from '../../src/logic/needs-judgement.js';

test('items.needs-judgement.lists-wall-and-decision: clause 1: needsJudgement(returned) lists each item whose stop reason is wall or decision with the reason, the latest refusal text and the attempt count, and omits abandoned, rework and blocked items [C7,#2220]', () => {
  const returned = [
    { id: 1, reason: 'wall', refusalText: 'GATE_RED: twice', attempts: 3 },
    { id: 2, reason: 'abandoned', refusalText: '', attempts: 1 },
    { id: 3, reason: 'decision', refusalText: 'needs a ruling', attempts: 2 },
    { id: 4, reason: 'rework', refusalText: 'rejected once', attempts: 1 },
    { id: 5, reason: 'blocked', refusalText: 'waits on #9', attempts: 0 },
  ];
  assert.deepEqual(needsJudgement(returned), [
    { id: 1, reason: 'wall', refusalText: 'GATE_RED: twice', attempts: 3 },
    { id: 3, reason: 'decision', refusalText: 'needs a ruling', attempts: 2 },
  ]);
  assert.deepEqual(needsJudgement([]), []);
});
