/** @pullboard-test-input docs/unblock.md README.md */
/** @pullboard-world-pin reads the shipped unblock page and README to check the rule, the commands and the link. */
/** The unblock page keeps its rule, its person-decides line, its commands and its README link [I1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('./unblock.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the unblock page says when it applies and that the person decides [I1]', () => {
  assert.match(page, /^## When it applies$/mu);
  assert.match(page, /cannot pass its own fix/u);
  assert.match(page, /^## The person decides$/mu);
  assert.match(page, /The person decides, every time\. It is never an agent's routine\./u);
});

test('the unblock page names every command [I1]', () => {
  for (const command of [
    'pullboard test --compare-main --wait <files>',
    'git merge --no-ff <sha>',
    'pullboard merged <id> <sha> --forced',
    'pullboard escalate <id> --note',
  ]) assert.ok(page.includes(command), `missing ${command}`);
});

test('the README links to the unblock page [I1]', () => {
  assert.match(readme, /\]\(docs\/unblock\.md\)/u);
});
