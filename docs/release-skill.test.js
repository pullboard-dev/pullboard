/** @pullboard-test-input skills/pullboard-release/SKILL.md */
/** @pullboard-world-pin: reads the shipped skill file and pins its approved digest so the text cannot drift. */
/** The shipped release skill is byte-identical to the approved Studio text [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the release skill ships byte-identical to the approved text [C7]', () => {
  const skill = readFileSync(new URL('../skills/pullboard-release/SKILL.md', import.meta.url));
  assert.match(skill.toString('utf8'), /^---\nname: pullboard-release\n/u);
  assert.equal(createHash('sha256').update(skill).digest('hex'), readFileSync(new URL('./release-skill.sha256', import.meta.url), 'utf8').trim());
});
