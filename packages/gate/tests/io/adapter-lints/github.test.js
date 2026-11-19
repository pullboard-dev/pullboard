/** @pullboard-test-input source-cell gate */
/** The GitHub lint names a direct GitHub API reference outside the GitHub adapter and holds today's offenders at a ceiling [C7,#1429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  GITHUB_CEILING_FILE,
  githubLintRows,
} from '../../../src/io/adapter-lints/github.js';

/** A scratch repo holding `files`, with an optional ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-githublint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(GITHUB_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('gate.io-adapter-lints-github.with-the-setting-on-a-reference: clause 1: with the setting on, a file outside the GitHub adapter naming api.github.com, GITHUB_API_URL or PULLBOARD_GITHUB_API fails naming file, line and adapter [C7,#1429]', () => {
  const root = repo({
    'packages/a/src/x.js': "export const a = 1;\nconst base = 'https://api.github.com';\nconst env = process.env.GITHUB_API_URL;\nconst other = process.env.PULLBOARD_GITHUB_API;\n",
    'packages/github/src/io/adapter/request.js': "const BASE = 'https://api.github.com';\n",
  });
  const rows = githubLintRows(root, { enabled: true });
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:2: api\.github\.com reaches GitHub outside the GitHub adapter/u);
  assert.match(rows[1], /^packages\/a\/src\/x\.js:3: GITHUB_API_URL reaches GitHub outside the GitHub adapter/u);
  assert.match(rows[2], /^packages\/a\/src\/x\.js:4: PULLBOARD_GITHUB_API reaches GitHub outside the GitHub adapter/u);
  assert.ok(rows.every(row => row.includes('use the GitHub adapter in packages/github/src/io/adapter/request.js')));
  assert.ok(rows.every(row => !row.startsWith('packages/github/src/io/adapter/')), 'the GitHub adapter is exempt');
});

test('gate.io-adapter-lints-github.comments-and-tests-are-not-references: clause 1: comments and tests are not GitHub references [C7,#1429]', () => {
  const root = repo({
    'packages/a/src/x.js': "// https://api.github.com\n/* GITHUB_API_URL */\n * PULLBOARD_GITHUB_API\nconst b = spawn('git', ['status']);\n",
    'packages/a/tests/x.test.js': "const base = 'https://api.github.com';\n",
  });
  assert.deepEqual(githubLintRows(root, { enabled: true }), []);
});

test('gate.io-adapter-lints-github.offenders-at-their-ceiling-pass-and: clause 2: offenders at their ceiling pass and one more reference in the same file fails; the ceiling never rises [C7,#1429]', () => {
  const files = { 'packages/a/src/x.js': "const a = 'https://api.github.com';\nconst b = process.env.GITHUB_API_URL;\n", 'packages/b/src/y.js': "const a = 'https://api.github.com';\n" };
  const root = repo(files, { 'packages/a/src/x.js': 2 });
  const rows = githubLintRows(root, { enabled: true });
  assert.deepEqual(rows.map(row => row.split(':')[0]), ['packages/b/src/y.js'], 'a file past its ceiling (zero for an unlisted file) fails');
  const grown = repo({ 'packages/a/src/x.js': "const a = 'https://api.github.com';\nconst b = process.env.GITHUB_API_URL;\nconst c = process.env.PULLBOARD_GITHUB_API;\n" }, { 'packages/a/src/x.js': 2 });
  assert.equal(githubLintRows(grown, { enabled: true }).length, 3);
});

test('gate.io-adapter-lints-github.with-the-setting-off-which-is: clause 2: with the setting off, which is the default, the lint reports nothing [C7,#1429]', () => {
  const root = repo({ 'packages/a/src/x.js': "const a = 'https://api.github.com';\n" });
  assert.deepEqual(githubLintRows(root), []);
  assert.deepEqual(githubLintRows(root, { enabled: false }), []);
  assert.deepEqual(githubLintRows(root, { enabled: 'yes' }), []);
});
