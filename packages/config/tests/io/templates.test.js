/** @pullboard-test-loads packages/config/src/io/templates.js */
/** The seat loop tells a seat to wait one minute on next, repeat at once, and stop only on an idle board [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEAT_LOOP } from '../../src/io/templates.js';
import { SEAT_LOOP_WORD_BUDGET } from '../../src/io/templates.js';
import { renderAgentsBlock } from '../../src/io/templates.js';
import { renderCodexAutomation } from '../../src/io/templates.js';
import { renderCoordinatorGuide } from '../../src/io/templates.js';
import { renderWorkerSkill } from '../../src/io/templates.js';

const WAIT_STOP_LINES = [
  'Never wait, never sleep, never poll, never stop while the board has work.',
  '`pullboard next --wait 1`',
  'On an empty answer, wait 1 s, then 2 s, 4 s and so on up to 60 s; run it again.',
  '`pullboard next --verify --wait 1`',
  'only when the wait reached 60 s and `next` is still empty.',
];

test('config.io-templates.seat-loop-waits: clause 1: SEAT_LOOP waits on next --wait 1, backs off on an empty answer, stops only at the 60 s wait and stays within its word budget [C7]', () => {
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

test('config.io-templates.agents-worktree: #12988 clause 1: the generated Lanes line opens and joins a seat with the lane, worktree and model [C7]', () => {
  const lanesLine = renderAgentsBlock().split('\n').find(line => line.startsWith('- **Lanes:**'));
  assert.equal(lanesLine, '- **Lanes:** open and join one with `pullboard worktree <lane> --model "<model name>"`.');
});

test('config.io-templates.seat-loop-reviewer: #12988 clause 1: a review-lane seat reviews submissions, loops on next --verify and stays within the unchanged word budget [C7]', () => {
  assert.ok(SEAT_LOOP.includes('- **Review:** A review-lane seat reviews; loop with `pullboard next --verify --wait 1`.'));
  assert.equal(SEAT_LOOP_WORD_BUDGET, 160, 'the approved word budget stays unchanged');
  const words = SEAT_LOOP.split(/\s+/u).filter(Boolean).length;
  assert.ok(words <= SEAT_LOOP_WORD_BUDGET, `${words} words exceed ${SEAT_LOOP_WORD_BUDGET}`);
});

test('config.io-templates.coordinator-landing: #12988 clause 1: the coordinator guide no longer names land --due or --dry-run and says accepted items land by themselves [C7]', () => {
  const guide = renderCoordinatorGuide();
  assert.ok(!guide.includes('land --due'));
  assert.ok(!guide.includes('--dry-run'));
  assert.ok(guide.includes('- **Landing:** accepted items land by themselves; watch them with `pullboard merged`.'));
});

test('config.io-templates.coordinator-staffing: #12988 clause 1: the coordinator loop has a staffing step from the buildable-at-once count and replaces stopped seats [C7]', () => {
  const step = renderCoordinatorGuide().split('\n').find(line => line.startsWith('1. **Seats first:**'));
  assert.ok(step, 'the loop has a staffing step');
  assert.ok(step.includes('builder and review seats'));
  assert.ok(step.includes('buildable-at-once count in `pullboard status`'));
  assert.ok(step.includes('replace any seat that stopped'));
});

test('config.io-templates.seat-loop-graceful-wait: #12988 clause 1: SEAT_LOOP waits 1 s, 2 s, 4 s up to 60 s on an empty next, stops only at 60 s and stays within the unchanged word budget [C7]', () => {
  assert.ok(SEAT_LOOP.includes('On an empty answer, wait 1 s, then 2 s, 4 s and so on up to 60 s; run it again.'));
  assert.ok(SEAT_LOOP.includes('- **Stop:** only when the wait reached 60 s and `next` is still empty.'));
  assert.doesNotMatch(SEAT_LOOP, /after 4 empty/u);
  assert.equal(SEAT_LOOP_WORD_BUDGET, 160, 'the approved word budget stays unchanged');
  const words = SEAT_LOOP.split(/\s+/u).filter(Boolean).length;
  assert.ok(words <= SEAT_LOOP_WORD_BUDGET, `${words} words exceed ${SEAT_LOOP_WORD_BUDGET}`);
});

test('config.io-templates.coordinator-seats-first: #12988 clause 1: the coordinator loop launches the status staffing seats before planning and says they queue on next until the plan lands items [C7]', () => {
  const lines = renderCoordinatorGuide().split('\n');
  const first = lines.find(line => /^1\. /u.test(line));
  assert.ok(first.startsWith('1. **Seats first:** launch the builder and review seats that the buildable-at-once count in `pullboard status` names, before planning;'));
  assert.ok(first.includes('they queue on `next` until the plan lands items'));
  const filing = lines.findIndex(line => line.includes('**File:**'));
  assert.ok(lines.indexOf(first) < filing, 'seats launch before the planning step');
});

test('config.io-templates.coordinator-runner-local: #12988 clause 1: the Capacity line names pullboard runner local when runner list prints no runners registered [C7]', () => {
  const capacity = renderCoordinatorGuide().split('\n').find(line => line.startsWith('- **Capacity:**'));
  assert.ok(capacity.includes('when it prints no runners registered, `pullboard runner local` starts this machine\'s own runner'));
});

test('config.io-templates.coordinator-watching-inbox-wait: #12988 clause 1: the Watching section lists pullboard inbox --wait first with its meaning, before the pipeline line [C7]', () => {
  const watching = renderCoordinatorGuide().split('### Watching\n\n')[1].split('\n');
  assert.equal(watching[0], '- **Inbox:** `pullboard inbox --wait`: returns on a shout to the coordinator, or when nothing is open.');
  assert.ok(watching[1].startsWith('- **Pipeline:**'));
});
