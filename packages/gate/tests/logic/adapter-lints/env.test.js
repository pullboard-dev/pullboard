/** @pullboard-test-input source-cell gate */
/** The environment lint names a direct process.env or config-file read outside the kernel and holds today's offenders at a ceiling [C7,#9448]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  ENV_CEILING_FILE,
  envLintRows,
} from '../../../src/io/adapter-lints/env.js';

/** A scratch repo holding `files`, with an optional ceilings file. */
function repo(files, ceilings) {
  const tree = privateFixtureFiles('pb-envlint-');
  for (const [path, text] of Object.entries(files)) tree.write(path, text);
  if (ceilings) tree.write(ENV_CEILING_FILE, JSON.stringify({ version: 1, files: ceilings }));
  return tree.root;
}

test('gate.logic-adapter-lints-env.with-the-setting-on-a-file: clause 1: with the setting on, a file outside the kernel reading process.env and config files fails naming file, line and adapter [C7,#9448]', () => {
  const root = repo({
    'packages/a/src/x.js': "export const a = 1;\nexport const home = process.env.HOME;\nconst raw = readFileSync(join(root, 'config.json'), 'utf8');\n",
    'packages/kernel/src/logic/env.js': 'export const env = () => process.env;\n',
  });
  const rows = envLintRows(root, { enabled: true });
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^packages\/a\/src\/x\.js:2: process\.env read directly outside the kernel/u);
  assert.match(rows[1], /^packages\/a\/src\/x\.js:3: 'config\.json' read directly/u);
  assert.ok(rows.every(row => row.includes('use the environment adapter in packages/kernel')));
  assert.ok(rows.every(row => !row.includes('packages/kernel/src')), 'the kernel folder is exempt');
});

test('gate.logic-adapter-lints-env.comments-tests-and-look-alike-names: clause 1: comments, tests and look-alike names are not direct reads [C7,#9448]', () => {
  const root = repo({
    'packages/a/src/x.js': "// process.env is read by the adapter\n/** a config.json file */\nconst a = options.process.env;\nconst b = 'my-config.txt';\n",
    'packages/a/tests/x.test.js': 'process.env.X;\n',
  });
  assert.deepEqual(envLintRows(root, { enabled: true }), []);
});

test('gate.logic-adapter-lints-env.offenders-at-their-ceiling-pass-and: clause 2: offenders at their ceiling pass and a new read in the same file fails; the ceiling never rises [C7,#9448]', () => {
  const files = { 'packages/a/src/x.js': 'process.env.A;\nprocess.env.B;\n', 'packages/b/src/y.js': 'process.env.C;\n' };
  const root = repo(files, { 'packages/a/src/x.js': 2 });
  const rows = envLintRows(root, { enabled: true });
  assert.deepEqual(rows.map(row => row.split(':')[0]), ['packages/b/src/y.js'], 'a file past its ceiling (zero for an unlisted file) fails');
  const grown = repo({ 'packages/a/src/x.js': "process.env.A;\nprocess.env.B;\nreadFileSync('settings.json');\n" }, { 'packages/a/src/x.js': 2 });
  assert.equal(envLintRows(grown, { enabled: true }).length, 3);
});

test('gate.logic-adapter-lints-env.with-the-setting-off-which-is: clause 2: with the setting off, which is the default, the lint reports nothing [C7,#9448]', () => {
  const root = repo({ 'packages/a/src/x.js': 'process.env.A;\n' });
  assert.deepEqual(envLintRows(root), []);
  assert.deepEqual(envLintRows(root, { enabled: false }), []);
  assert.deepEqual(envLintRows(root, { enabled: 'yes' }), []);
});
