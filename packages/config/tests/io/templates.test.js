/** @pullboard-test-loads packages/config/src/io/templates.js */
/** The seat loop tells a seat to wait one minute on next, repeat at once, and stop only on an idle board [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEAT_LOOP } from '../../src/io/templates.js';
import { SEAT_LOOP_WORD_BUDGET } from '../../src/io/templates.js';
import { renderAgentsBlock } from '../../src/io/templates.js';
import { renderCodexAutomation } from '../../src/io/templates.js';
import { renderWorkerSkill } from '../../src/io/templates.js';

const WAIT_STOP_LINES = [
  'Never wait, never sleep, never poll, never stop while the board has work.',
  '`pullboard next --wait 1`',
  'On an empty answer, run it again at once.',
  '`pullboard next --verify --wait 1`',
  'only when `pullboard status` shows nothing open, building, in gate or in review.',
];

test('config.io-templates.seat-loop-waits: clause 1: SEAT_LOOP waits on next --wait 1, repeats at once, stops only on an idle board and stays within its word budget [C7]', () => {
  for (const line of WAIT_STOP_LINES) assert.ok(SEAT_LOOP.includes(line), `SEAT_LOOP carries: ${line}`);
  assert.doesNotMatch(SEAT_LOOP, /after 4 empty/u);
  assert.equal(SEAT_LOOP_WORD_BUDGET, 160, 'the budget is unraised');
  const words = SEAT_LOOP.split(/\s+/u).filter(Boolean).length;
  assert.ok(words <= SEAT_LOOP_WORD_BUDGET, `${words} words exceed ${SEAT_LOOP_WORD_BUDGET}`);
});

test('config.io-templates.skill-and-automation-match: clause 2: the worker skill and the Codex automation carry the same wait and stop lines as SEAT_LOOP [C7]', () => {
  const skill = renderWorkerSkill();
  const prompt = JSON.parse(/^prompt = (.*)$/mu.exec(renderCodexAutomation())[1]);
  for (const line of WAIT_STOP_LINES) {
    assert.ok(skill.includes(line), `the skill carries: ${line}`);
    assert.ok(prompt.includes(line), `the automation carries: ${line}`);
  }
  assert.doesNotMatch(skill, /after 4 empty/u);
  assert.doesNotMatch(prompt, /after 4 empty/u);
});

test('config.io-templates.seat-loop-seat-folder: clause 2: next, status and shout name the seat folder and NOT_JOINED refusal [C7]', () => {
  const seatFolderLine = 'Run `next`, `status` and `shout` from your seat folder, not its item folder; the item folder gets `NOT_JOINED` otherwise.';
  assert.ok(SEAT_LOOP.includes(seatFolderLine));
  assert.ok(renderWorkerSkill().includes(seatFolderLine));
});

test('config.io-templates.agents-worktree: #11782 clause 1: the generated Lanes line opens and joins a seat with the lane, worktree and model [C7]', () => {
  const lanesLine = renderAgentsBlock().split('\n').find(line => line.startsWith('- **Lanes:**'));
  assert.equal(lanesLine, '- **Lanes:** open and join one with `pullboard worktree <lane> --model "<model name>"`.');
});

test('config.io-templates.seat-loop-reviewer: #11782 clause 2: a review-lane seat reviews submissions, loops on next --verify and stays within the unchanged word budget [C7]', () => {
  assert.ok(SEAT_LOOP.includes('- **Review:** A review-lane seat reviews; loop with `pullboard next --verify --wait 1`.'));
  assert.equal(SEAT_LOOP_WORD_BUDGET, 160, 'the approved word budget stays unchanged');
  const words = SEAT_LOOP.split(/\s+/u).filter(Boolean).length;
  assert.ok(words <= SEAT_LOOP_WORD_BUDGET, `${words} words exceed ${SEAT_LOOP_WORD_BUDGET}`);
});
