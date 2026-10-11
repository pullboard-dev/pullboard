/** The run skill tells coordinators to surface measured bottlenecks to the person [N31]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const skill = readFileSync(new URL('../skills/pullboard-run/SKILL.md', import.meta.url), 'utf8');

test('the run skill tells the person about bottlenecks [N31]', () => {
  assert.match(skill, /every coordinator cycle, check the flow/u, 'each coordinator cycle starts by checking flow');
  assert.match(skill, /`flow:` line in `pullboard resume`, or from `pullboard stats --json`/u,
    'the instruction names both supported flow sources');
  assert.match(skill, /`pullboard shout person "\.\.\."` to tell the person in one plain sentence/u,
    'a named bottleneck is sent to the person in one sentence');
  assert.match(skill, /what is slow, the reported numbers, and the action that would fix it/u,
    'the sentence names the delay, its numbers, and the remedy');
  assert.match(skill, /Use the reported values and recommendation; do not calculate new numbers/u,
    'the coordinator reports existing measurements without inventing them');
  assert.match(skill, /Ask for a decision only when the fix needs the person's choice or authorization/u,
    'a decision is requested only when a person must choose or authorize the fix');
});
