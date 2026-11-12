/** @pullboard-test-input docs/unblock.md README.md */
/** @pullboard-world-pin reads the shipped unblock page and README to check the rule, the commands and the link. */
/** The unblock page keeps its rule, its person-decides line, its commands and its README link [I1]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runCliInProcess } from '../apps/cli/tests/fixtures/process.js';

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
    'git merge --no-ff <candidate-sha>',
    'git rev-parse HEAD',
    'pullboard merged <id> <HEAD-sha> --forced',
    'pullboard escalate <id> --note',
  ]) assert.ok(page.includes(command), `missing ${command}`);
});

test('the land step records the merge commit HEAD points to, named apart from the candidate [I1]', () => {
  assert.match(page, /the merge commit that `HEAD` points to after the merge, not the candidate sha/u);
  assert.doesNotMatch(page, /pullboard merged <id> <(?:candidate-)?sha>/u, 'the landing must not be the candidate sha');
  assert.ok(page.indexOf('git merge --no-ff') < page.indexOf('git rev-parse HEAD') && page.indexOf('git rev-parse HEAD') < page.indexOf('pullboard merged'), 'read HEAD between the merge and the record');
});

test('every flag the page uses is one its command lists in --help [I1]', async () => {
  const helps = { 'pullboard test': ['--compare-main', '--wait'], 'pullboard merged': ['--forced'], 'pullboard escalate': ['--note'] };
  for (const line of page.split('\n').filter((text) => /^pullboard (?:test|merged|escalate) /u.test(text))) {
    const command = line.match(/^pullboard (?:test|merged|escalate)/u)[0];
    for (const flag of line.match(/--[a-z-]+/gu) ?? []) assert.ok(helps[command].includes(flag), `${command} has no ${flag}`);
  }
  const help = async (args) => { const run = await runCliInProcess([...args, '--help']); return `${run.stdout}${run.stderr}`; };
  for (const [command, flags] of Object.entries(helps)) {
    const text = await help(command.split(' ').slice(1));
    for (const flag of flags) assert.ok(text.includes(flag), `${command} --help does not list ${flag}`);
  }
});

test('the README links to the unblock page [I1]', () => {
  assert.match(readme, /\]\(docs\/unblock\.md\)/u);
});
