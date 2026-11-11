/** The run guide lists every refusal of the notBuilder guard and starts verifiers in separate sessions [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GUARDS } from '../packages/state/index.js';

/** @pullboard-world-pin reads the shipped run guide to check it against the guard's refusal list. */
const skill = readFileSync(new URL('../skills/pullboard-run/SKILL.md', import.meta.url), 'utf8');

/** Return the part of the guide under one level-two heading. */
function section(title) {
  const start = skill.indexOf(`\n## ${title}\n`);
  assert.notEqual(start, -1, `the guide has a ${title} section`);
  const end = skill.indexOf('\n## ', start + 1);
  return skill.slice(start, end < 0 ? skill.length : end);
}

test('clause 1: the guide names the notBuilder identity refusals the guard raises [C7]', () => {
  const guard = GUARDS.find(entry => entry.id === 'notBuilder');
  assert.ok(guard, 'machine-declaration has the notBuilder guard');
  const raised = [guard.refuse, ...(guard.alsoRefuses ?? []).map(entry => entry.code)];
  const identity = ['SELF_VERIFY', 'VERIFIER_STANDING', 'SELF_SESSION_VERIFY'];
  for (const code of identity) assert.ok(raised.includes(code), `${code} is raised by the notBuilder guard`);
  const reviews = section('Keep reviews independent');
  for (const code of identity) assert.ok(reviews.includes(`\`${code}\``), `the guide names ${code}`);
  assert.doesNotMatch(reviews, /refuses only the builder/u, 'the guide no longer claims only the builder is refused');
});

test('clause 2: step 5 starts verifiers in a separate session, never as subagents of the coordinator [C7]', () => {
  const line = skill.split('\n').find(row => row.startsWith('5. **Verify'));
  assert.ok(line, 'the guide has a step 5 for verifying');
  assert.match(line, /separate session/u, 'step 5 starts a separate session');
  assert.match(line, /never a subagent of yours/u, 'step 5 forbids a subagent of the coordinator session');
  assert.match(line, /SELF_SESSION_VERIFY/u, 'step 5 names the refusal');
  assert.doesNotMatch(line, /start a subagent with its opening lines/u, 'step 5 no longer starts a subagent');
});
