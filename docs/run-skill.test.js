/** The run skill tells coordinators to surface measured bottlenecks to the person [N31]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const skill = readFileSync(new URL('../skills/pullboard-run/SKILL.md', import.meta.url), 'utf8');

test('the run skill tells the person about bottlenecks [N31]', () => {
  const flow = skill.split('\n').find(row => row.startsWith('- **Flow:**'));
  assert.ok(flow, 'each coordinator cycle checks flow');
  assert.match(flow, /`flow:` line in `pullboard resume` or `pullboard stats --json`/u, 'the instruction names both supported flow sources');
  assert.match(flow, /`pullboard shout person "\.\.\."`/u, 'a named bottleneck is sent to the person');
  assert.match(flow, /in one sentence/u, 'in one sentence');
  assert.match(flow, /what's slow, the board's numbers, the fix/u, 'the sentence names the delay, its numbers, and the remedy');
  assert.match(skill, /Report flow with the board's numbers\. Never compute your own\./u, 'the coordinator reports existing measurements without inventing them');
  assert.match(flow, /Ask only when the fix needs their choice or OK\./u, 'a decision is requested only when a person must choose or authorize the fix');
});

test('the run skill reopens a red batch culprit only after a paired control proves it [I1]', () => {
  const rule = skill.split('\n').find(row => row.startsWith('- Reopen a landing culprit only with a paired control'));
  assert.ok(rule, 'the rule names the paired control as the only proof that reopens a culprit');
  assert.match(rule, /the same failing test passes on main and fails on the candidate/u, 'a proof needs a green control and a red candidate');
  assert.match(rule, /`pullboard hold <id> "[^"]+"`/u, 'an unproven culprit stays held');
  assert.ok(rule.indexOf('paired control') < rule.indexOf('pullboard reopen <id>'), 'the paired control comes before the reopen it authorizes');
});
