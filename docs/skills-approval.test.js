/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the shipped skills and the refusal source to check they name pullboard view. */
/** Both spec skills and the person-channel refusal send approval to pullboard view [I1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('decompose and plan skills tell the person to approve in pullboard view [I1]', () => {
  for (const skill of ['pullboard-decompose', 'pullboard-plan']) {
    const text = readFileSync(resolve(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /approve (the rows|them):\n\s+- `pullboard view`/, skill);
  }
  const decompose = readFileSync(resolve(ROOT, 'skills', 'pullboard-decompose', 'SKILL.md'), 'utf8');
  assert.match(decompose, /`pullboard spec approve` is refused/);
});

test('the B26_PERSON_CHANNEL refusal next step names pullboard view [I1]', () => {
  const text = readFileSync(resolve(ROOT, 'packages/moves/src/logic/moves/approveOutside.js'), 'utf8');
  assert.match(text, /"B26_PERSON_CHANNEL": "[^"]*pullboard view/);
});
