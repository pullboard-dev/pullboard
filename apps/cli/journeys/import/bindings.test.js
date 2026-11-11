/** Pre-commit splits multi-binding import lines and re-stages them, so the gate never refuses for that style [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  fixStagedImportBindings,
  splitImportBindings,
} from '../../../../packages/commits/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const TWO = "import { first, second as renamed } from './values.js';\nimport main, { extra } from './other.js';\nexport const total = [first, renamed, main, extra];\n";

/** A real Git repository with identity set only for the fixture. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-import-fix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  return { root, git, put };
}

test('a staged two-binding import line lands split and staged, with the same imports [C7]', t => {
  const box = repository(t);
  box.put('src/values.js', 'export const first = 1, second = 2;\n');
  box.put('src/other.js', 'export default 3; export const extra = 4;\n');
  box.put('src/two.js', TWO);
  box.git('add', '-A');
  const notes = fixStagedImportBindings(box.root);
  assert.match(notes.join('\n'), /src\/two\.js/u);
  const staged = box.git('show', ':src/two.js');
  assert.equal(staged.trimEnd(), readFileSync(join(box.root, 'src/two.js'), 'utf8').trimEnd(), 'the staged bytes are the fixed bytes');
  assert.equal(box.git('diff', '--name-only'), '', 'nothing is left unstaged');
  for (const line of staged.split('\n').filter(row => row.startsWith('import'))) assert.ok(!/\bfirst\b.*\bsecond\b|\bmain\b.*\bextra\b/u.test(line), `a line still holds two bindings: ${line}`);
  assert.deepEqual(importsIn([TWO])[0], importsIn([staged])[0], 'the module still imports the same specifiers');
});

test('a partly staged file is left alone and a clean file is not rewritten [C7]', t => {
  const box = repository(t);
  box.put('src/two.js', TWO);
  box.put('src/clean.js', "import { only } from './x.js';\nexport { only };\n");
  box.git('add', '-A');
  writeFileSync(join(box.root, 'src/two.js'), TWO + '// local edit\n');
  const notes = fixStagedImportBindings(box.root);
  assert.deepEqual(notes, []);
  assert.equal(readFileSync(join(box.root, 'src/two.js'), 'utf8'), TWO + '// local edit\n');
});

test('splitting handles multi-line import blocks and leaves other lines alone [C7]', () => {
  const source = "import {\n  a, b,\n  c,\n} from 'x';\nconst object = { a, b };\nimport 'side-effect';\n";
  const { source: fixed, changed } = splitImportBindings(source);
  assert.ok(changed);
  assert.equal(fixed, "import {\n  a,\n  b,\n  c,\n} from 'x';\nconst object = { a, b };\nimport 'side-effect';\n");
  assert.equal(splitImportBindings(fixed).changed, false);
});


test('staged import-like templates, strings, regexes and comments keep their exact program data [C7]', t => {
  const box = repository(t);
  const data = [
    'const template = `',
    "import { first, second } from './values.js';",
    'import {',
    '  first, second,',
    "} from './values.js';",
    '`;',
    'const nested = `outer ${`inner',
    "import { first, second } from './values.js';",
    '`} outer`;',
    '/*',
    "import { first, second } from './values.js';",
    '*/',
    'const string = "import { first, second } from \'./values.js\';";',
    String.raw`const regex = /import\s*\{first,second\}/;`,
    '',
  ].join('\n');
  box.put('src/data.js', data);
  box.git('add', '-A');
  const staged = box.git('show', ':src/data.js');
  assert.deepEqual(fixStagedImportBindings(box.root), []);
  assert.equal(readFileSync(join(box.root, 'src/data.js'), 'utf8'), data);
  assert.equal(box.git('show', ':src/data.js'), staged, 'the index keeps exactly the original program data');
  assert.equal(splitImportBindings(data).changed, false);
});

test('a real multiline import splits its bindings without rewriting a block comment inside it [C7]', () => {
  const source = "import {\n  /*\n  first, second,\n  } not a closing import brace\n  */\n  alpha, beta,\n} from './values.js';\n";
  const expected = source.replace('  alpha, beta,', '  alpha,\n  beta,');
  const fixed = splitImportBindings(source);
  assert.equal(fixed.source, expected);
  assert.equal(fixed.changed, true);
  assert.equal(splitImportBindings(expected).changed, false);
});

test('the installed pre-commit hook lands a two-binding import already split and re-staged [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/values.js'), 'export const first = 1, second = 2;\n');
  writeFileSync(join(box.repo, 'src/other.js'), 'export default 3; export const extra = 4;\n');
  writeFileSync(join(box.repo, 'src/two.js'), TWO);
  box.git(box.repo, 'add', 'src');
  box.git(box.repo, 'commit', '-q', '-m', 'feat: commit automatically split imports [G1]');
  const landed = box.git(box.repo, 'show', 'HEAD:src/two.js');
  assert.notEqual(landed.trimEnd(), TWO.trimEnd(), 'the actual hook rewrote the staged two-binding import');
  assert.equal(landed.trimEnd(), splitImportBindings(TWO).source.trimEnd());
  assert.equal(readFileSync(join(box.repo, 'src/two.js'), 'utf8').trimEnd(), landed.trimEnd());
  assert.equal(box.git(box.repo, 'diff', '--name-only'), '');
  assert.equal(box.git(box.repo, 'diff', '--cached', '--name-only'), '');
  assert.deepEqual(importsIn([landed])[0], importsIn([TWO])[0]);
});


test('a staged source symlink never makes the fixer rewrite its target [C7]', t => {
  const box = repository(t);
  box.put('target.js', TWO);
  mkdirSync(join(box.root, 'src'));
  symlinkSync('../target.js', join(box.root, 'src/link.js'));
  box.git('add', '-A');
  const staged = box.git('show', ':src/link.js');
  assert.deepEqual(fixStagedImportBindings(box.root), []);
  assert.equal(readFileSync(join(box.root, 'target.js'), 'utf8'), TWO);
  assert.equal(box.git('show', ':src/link.js'), staged);
  assert.equal(box.git('diff', '--name-only'), '');
});


test('a method named import is ordinary executable code and never an import-binding block [C7]', () => {
  const source = 'class Values {\n  import() {\n    first, second;\n  }\n}\n';
  assert.deepEqual(splitImportBindings(source), { source, changed: false });
});
