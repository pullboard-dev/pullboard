/**
 * The commit-message rules (C1, C2) and the pre-commit pattern checks on real staged changes.
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureGit } from './fixture-child.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from '../src/config.js';
import { addedLines, blockedPaths, commitCitationWarnings, commitMsgProblems, matchesPattern, preCommitProblems, secretsIn } from '../src/hooks.js';
import { parseSpec } from '../src/spec.js';
import { Refused } from '../src/refused.js';

const SPEC = { ...parseSpec('## G\n- G1 [approved, must] One. | gate: t\n- G2 [retired] Gone.\n'), name: 'SPEC.md' };
const RULES = defaults().commits;

/** Make a private real repository for staged-diff hook tests, with cleanup tied to the test. */
function stagedRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-staged-diff-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Run Git only in this fixture, without the maintainer's identity or configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  return { root, git };
}

/** Run the same staged protections called by the installed pre-commit hook. */
function stagedProblems(root) {
  return preCommitProblems({ root, isMain: true, config: defaults(), agent: null });
}

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

test('doctrine citations are namespaced; a colliding bare id warns that it resolves to SPEC.md [A5]', () => {
  const doctrine = {
    name: 'DOCTRINE.md',
    repo: { rows: [{ id: 'G1', line: 4 }] },
    rows: [{ id: 'G1', status: 'approved' }, { id: 'PB1', status: 'approved' }],
  };
  assert.deepEqual(commitMsgProblems('feat(web): add the rule [doctrine:PB1]', { rules: RULES, spec: SPEC, doctrine }), []);
  assert.deepEqual(commitMsgProblems('feat(web): add the rule [doctrine:G1]', { rules: RULES, spec: SPEC, doctrine }), []);
  assert.match(commitMsgProblems('fix(web): add the rule [doctrine:missing]', { rules: RULES, spec: SPEC, doctrine })[0], /doctrine:missing is not in doctrine/u);
  assert.deepEqual(commitCitationWarnings('feat(web): patch the rule [G1]', { spec: SPEC, doctrine }), [
    'G1 is a known collision at SPEC.md:2 and DOCTRINE.md:4; bare ids cite SPEC.md, use doctrine:G1 for a doctrine row',
  ]);
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

test('the secret scan handles 2.4 MiB of binary images and finds an embedded key [P4]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  for (let index = 0; index < 17; index += 1) {
    const image = Buffer.alloc(150_000);
    image.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
    if (index === 0) image.write(`${secret}\n`, 11, 'ascii');
    writeFileSync(join(box.root, `image-${index}.jpg`), image);
  }
  box.git('add', '--', '*.jpg');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at image-0.jpg:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('a staged diff beyond the safe output limit is a private coded refusal [P4]', (t) => {
  const box = stagedRepo(t);
  const marker = 'STAGED_CONTENT_MUST_NOT_BE_ECHOED';
  writeFileSync(join(box.root, 'large.txt'), `${marker}\n${'ordinary text\n'.repeat(700_000)}`);
  box.git('add', '--', 'large.txt');
  assert.throws(() => stagedProblems(box.root), (error) => {
    assert.ok(error instanceof Refused);
    assert.equal(error.code, 'DIFF_TOO_LARGE');
    assert.match(error.message, /split the change into smaller commits, then retry/);
    assert.ok(!error.message.includes(marker));
    return true;
  });
});

test('pre-commit still refuses and redacts a staged text secret [P4]', (t) => {
  const box = stagedRepo(t);
  const secret = `sk-ant-${'A'.repeat(32)}`;
  writeFileSync(join(box.root, 'settings.js'), `const token = \"${secret}\";\n`);
  box.git('add', '--', 'settings.js');
  const problems = stagedProblems(box.root);
  assert.deepEqual(problems, ['possible secret: Anthropic key at settings.js:1']);
  assert.ok(!problems.join(' ').includes(secret));
});

test('a refused merge message points to the message git writes, which is exempt [C4]', () => {
  assert.match(check('merge: include store date validation')[0], /For a merge, keep the message git writes, which is exempt: git merge --no-edit/);
  assert.deepEqual(check("Merge branch 'store/1'"), []);
});
