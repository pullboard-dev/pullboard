/** @pullboard-test-loads packages/config/src/io/templates.js */
/** The seat loop tells a seat to wait one minute on next, repeat at once, and stop only on an idle board [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEAT_LOOP } from '../../src/io/templates.js';
import { SEAT_LOOP_WORD_BUDGET } from '../../src/io/templates.js';
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
