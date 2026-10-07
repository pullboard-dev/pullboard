/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks, without git.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '../src/config.js';
import { addedLines, blockedPaths, commitMsgProblems, matchesPattern, secretsIn } from '../src/hooks.js';
import { parseSpec } from '../src/spec.js';

const SPEC = { ...parseSpec('## G\n- G1 [approved, must] One. | gate: t\n- G2 [retired] Gone.\n'), name: 'SPEC.md' };
const RULES = defaults().commits;

/**
 * Problems with a message under the default rules, or the given ones.
 */
const check = (message, rules = RULES) => commitMsgProblems(message, { rules, spec: SPEC });

test('a clean header citing a live id passes [C1, C2]', () => {
  assert.deepEqual(check('feat(web): add the page [G1]'), []);
  assert.deepEqual(check('docs: explain lanes'), []);
  assert.deepEqual(check('feat(web)!: drop the old page [G1]\n\nThe old page is gone.'), []);
});

test('feat and fix cite ids; cited ids exist and are not retired [C2]', () => {
  assert.match(check('feat(web): add the page')[0], /end the header with the spec rows this feat serves, like \[G1,G2\]/);
  assert.match(check('fix: patch [G9]')[0], /G9 is not in SPEC.md/);
  assert.match(check('fix: patch [G2]')[0], /G2 is retired/);
});

test('header format, length, case and period [C1]', () => {
  assert.match(check('Added the page')[0], /type\(scope\): subject/);
  assert.match(check('Added the page')[0], /saw "Added the page"/, 'the refusal shows the header it saw (C4)');
  assert.match(check('feature: add the page [G1]')[0], /type\(scope\): subject/, 'a type outside the configured list is refused');
  assert.match(check(`docs: ${'x'.repeat(80)}`)[0], /shorten the header to 72 characters or fewer \(it has 86\)/);
  assert.deepEqual(check('docs: Explain lanes.'), [
    'start the subject with a lowercase letter (saw "Explain lanes.")',
    'remove the period at the end of the subject',
  ]);
  assert.match(check('feat: x [G K P D]')[0], /cite only rows that exist and are live, separated by commas like \[G1,G2\]/);
  assert.deepEqual(check('docs: explain lanes\nsecond line'), ['leave a blank line after the header']);
});

test('comments are dropped; merges, reverts and fixups are exempt', () => {
  assert.deepEqual(check('docs: explain lanes\n# Please enter the commit message'), []);
  assert.deepEqual(check("Merge branch 'web/page'"), []);
  assert.deepEqual(check('fixup! feat(web): add the page [G1]'), []);
});

test('opt-in rules: filler words, emoji, co-author trailers', () => {
  const strict = { ...RULES, banned: ['basically', 'seamless'], noEmoji: true, noCoAuthor: true };
  const problems = check('docs: basically seamless lanes \u{1F680}\n\nCo-Authored-By: Bot <b@x>', strict);
  assert.deepEqual(problems, ['drop the filler word "basically"', 'drop the filler word "seamless"', 'remove the emoji', 'remove the Co-Authored-By trailer']);
  assert.deepEqual(check('docs: basically fine'), []);
});

test('blocked paths: env files by name, examples allowed, patterns with a slash match paths', () => {
  const protect = { ...defaults().protect, blocked: [...defaults().protect.blocked, 'data/*.csv'] };
  assert.deepEqual(
    blockedPaths(['.env', 'app/.env.local', 'prod.env', '.env.example', 'data/claims.csv', 'docs/data/x.csv', 'src/a.js'], protect),
    ['.env', 'app/.env.local', 'prod.env', 'data/claims.csv'],
  );
  assert.ok(matchesPattern('*.env', 'deep/dir/staging.env'));
  assert.ok(!matchesPattern('.env.*', 'environment.js'));
});

test('secrets are named by kind and place, never echoed', () => {
  // Built at run time, so this file never holds a string its own pre-commit scan would refuse.
  const fakeKey = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz0123'].join('-');
  const diff = [
    '+++ b/config/settings.js',
    '@@ -0,0 +1,3 @@',
    '+const ok = 1;',
    `+const key = "${fakeKey}";`,
    '+export CLOUDFLARE_API_TOKEN=abcdefghijklmnopqrstuvwxyz012345',
  ].join('\n');
  const found = secretsIn(addedLines(diff));
  assert.deepEqual(found, ['Anthropic key at config/settings.js:2', 'env-style secret at config/settings.js:3']);
  assert.ok(found.every((entry) => !entry.includes('abcdefghij')));
});

test('a refused merge message points to the message git writes, which is exempt [C4]', () => {
  assert.match(check('merge: include store date validation')[0], /For a merge, keep the message git writes, which is exempt: git merge --no-edit/);
  assert.deepEqual(check("Merge branch 'store/1'"), []);
});
