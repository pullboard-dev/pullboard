/** @pullboard-test-input skills/pullboard-contribute/SKILL.md */
/** @pullboard-world-pin reads the shipped contribute skill from its real path to check what it tells the agent. */
/** The contribute skill gathers facts, keeps every constraint, redacts, and checks the record before submitting [CR4]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8').replace(/[ \t]*\n[ \t]*/gu, ' ');

test('skills.contribute.facts-constraints-redaction: clause 1: the skill gathers facts, copies every constraint into forbidden, compat and bar before compressing, and redacts secrets, tokens, home paths and hostnames [CR4]', () => {
  assert.match(skill, /^---\sname: pullboard-contribute\s/u);
  assert.match(skill, /\*\*Gather facts:\*\*/u);
  assert.match(skill, /Copy every constraint\*\* the person or the thread gave into `forbidden`, `compat` and `bar` before compressing/u);
  assert.match(skill, /\*\*Redact:\*\*/u);
  for (const kind of [/secrets, tokens and keys/u, /home paths/u, /hostnames and addresses/u]) assert.match(skill, kind);
});

test('skills.contribute.check-before-submit: clause 2: the skill writes the record, then runs pullboard contribute check before submitting [CR4]', () => {
  const write = skill.indexOf('**Write the record**'), check = skill.indexOf('`pullboard contribute check <file>`'), submit = skill.indexOf('**Submit**');
  assert.ok(write >= 0 && check > write && submit > check, 'write, then check, then submit');
  assert.match(skill, /Never submit a record that `pullboard contribute check` refuses/u);
});
