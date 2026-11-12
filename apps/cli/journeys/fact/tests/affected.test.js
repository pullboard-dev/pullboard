import { mappedWorkingSource } from '../../../../../packages/gate/src/io/scan.js';
/** @pullboard-test-input source-tree */
/** Documentation input selection remains conservative across committed trees [V4,C7]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { browserBoundFiles } from '../../../../../packages/gate/index.js';
import { testsNeedGui } from '../../../../../packages/gate/index.js';
import { importsIn } from '../../../../../packages/gate/index.js';
import { lex } from '../../../../../packages/kernel/index.js';
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { packageFiles } from '../../../../../packages/runners/index.js';
import { copyPackageSubset } from '../../../tests/fixtures/copy.js';
import { selectTestTreeGuards } from '../../../../../packages/gate/index.js';
import { installSubmitTestTreeCases } from '../../../tests/fixtures/submit/cases.js';

installSubmitTestTreeCases();

/** Make a real committed ES-module graph without executing any candidate source. */
function graph(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-doc-selection-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    GIT_AUTHOR_NAME:'Test Agent', GIT_AUTHOR_EMAIL:'agent@example.com',
    GIT_COMMITTER_NAME:'Test Agent', GIT_COMMITTER_EMAIL:'agent@example.com' };
  /** Run Git with the fixture's own identity and configuration. */
  const git = (...args) => runFixtureGit(args, { cwd:root, env });
  /** Write a fixture module or document, creating its parent directories. */
  const put = (path, body) => { mkdirSync(dirname(join(root,path)), { recursive:true }); writeFileSync(join(root,path),body); };
  /** Snapshot real Git objects so selection cannot read uncommitted working-tree bytes. */
  const commit = () => { git('add','-A'); git('commit','-qm','chore: selection fixture'); return git('rev-parse','HEAD').trim(); };
  git('init','-q','-b','main');
  put('package.json','{"type":"module"}\n');
  put('src/api.js','export const version = 1;\n');
  put('test/api.test.js',"import '../src/api.js';\n");
  put('src/labels.js',"import {readFileSync} from 'node:fs'; export const types=['feat','fix','docs','test']; export const config=()=>readFileSync('config.json'); export const isDoc=path=>path.startsWith('docs/');\n");
  put('test/unrelated.test.js',"import '../src/labels.js'; import assert from 'node:assert/strict'; assert.ok(true);\n");
  put('docs/api.md','# API\n');
  put('docs/other.md','# Other\n');
  put('docs/api.test.js',"import {readFileSync} from 'node:fs'; readFileSync(new URL('./api.md',import.meta.url),'utf8');\n");
  return { root,git,put,commit };
}

test('a docs change selects the tests that read it [V4,C7]', (t) => {
  const box = graph(t);
  box.put('test/docs.test.js',"import {readdirSync} from 'node:fs'; readdirSync('docs');\n");
  const base = box.commit();
  box.put('src/api.js','export const version = 2;\n');
  box.put('docs/api.md','# Updated API\n');
  const commit = box.commit();
  const combined = selectAffectedTests(box.root,{base,commit});
  assert.equal(combined.full,false,'documenting an API change must retain focused selection');
  assert.deepEqual(combined.files,['docs/api.test.js','test/api.test.js','test/docs.test.js']);
  const docs = selectAffectedTests(box.root,{base,commit,changed:['docs/api.md']});
  assert.equal(docs.full,false);
  assert.deepEqual(docs.files,['docs/api.test.js','test/docs.test.js']);
  for (const path of ['package.json','config.json','unknown.txt','docs/image.svg']) {
    assert.equal(selectAffectedTests(box.root,{base,commit,changed:[path]}).full,true,`${path} still needs the full suite`);
  }
});

test('doc readers include helper imports, directory paths and old edges [V4,C7]', (t) => {
  const box = graph(t);
  box.put('test/doc-helper.js',"import {readFileSync} from 'node:fs'; export const text=readFileSync(new URL('../docs/api.md',import.meta.url),'utf8');\n");
  box.put('test/helper-reader.test.js',"import './doc-helper.js';\n");
  box.put('test/split-reader.test.js',"import {readFileSync} from 'node:fs'; import {join} from 'node:path'; readFileSync(join('docs','api.md'),'utf8');\n");
  box.put('test/template-reader.test.js',"import {readdirSync} from 'node:fs'; const name='api'; readdirSync(`docs/${name}`);\n");
  box.put('test/escaped-reader.test.js',"import {readFileSync} from 'node:fs'; readFileSync('do\\x63s/api.md');\n");
  box.put('test/root-template.test.js',"import {readFileSync} from 'node:fs'; const root='.'; readFileSync(`${root}/docs/api.md`);\n");
  box.put('test/glob-reader.test.js',"import {globSync} from 'node:fs'; globSync('docs/**/*.md');\n");
  box.put('test/prefixed-reader.test.js',"import {readFileSync} from 'node:fs'; const root='.'; readFileSync(root + '/docs/api.md');\n");
  box.put('test/computed-reader.test.js',"import {readFileSync} from 'node:fs'; import {join} from 'node:path'; const name='api'; readFileSync(join('d'+'ocs',name+'.md'));\n");
  box.put('test/declared-reader.test.js',"/** @pullboard-test-input docs-tree */\nimport {readFileSync} from 'node:fs'; readFileSync(process.env.INPUT);\n");
  box.put('test/regex-reader.test.js', `import {readFileSync} from 'node:fs'; const quote=/['"]/; readFileSync('docs/api.md');\n`);
  const base = box.commit();
  box.put('test/doc-helper.js','export const text="no longer read";\n');
  const commit = box.commit();
  const selection = selectAffectedTests(box.root,{base,commit,changed:['docs/api.md']});
  assert.equal(selection.full,false);
  assert.deepEqual(selection.files,['docs/api.test.js','test/computed-reader.test.js','test/declared-reader.test.js','test/escaped-reader.test.js','test/glob-reader.test.js','test/helper-reader.test.js','test/prefixed-reader.test.js','test/regex-reader.test.js','test/root-template.test.js','test/split-reader.test.js','test/template-reader.test.js']);
});

test('an unread doc adds no tests and doc readers come from Git objects [V4,C7]', (t) => {
  const box = graph(t);
  const base = box.commit();
  box.put('docs/unread.md','# No readers\n');
  const commit = box.commit();
  box.put('test/unrelated.test.js',"import {readFileSync} from 'node:fs'; readFileSync('docs/unread.md');\n");
  assert.deepEqual(selectAffectedTests(box.root,{base,commit}),{full:false,reason:'',files:[],reasons:{}});
  assert.deepEqual(selectAffectedTests(box.root,{base,commit,changed:['src/api.js','docs/unread.md']}).files,['test/api.test.js']);
});


test('escaped literal templates select their documentation inputs [V4,C7]', (t) => {
  const box = graph(t);
  box.put('test/template-hex.test.js',"import {readFileSync} from 'node:fs'; readFileSync(`do\\x63s/api.md`);\n");
  box.put('test/template-unicode.test.js',"import {readFileSync} from 'node:fs'; readFileSync(`do\\u0063s/api.md`);\n");
  box.put('test/template-point.test.js',"import {readFileSync} from 'node:fs'; readFileSync(`do\\u{63}s/api.md`);\n");
  box.put('test/template-raw.test.js',"import {readFileSync} from 'node:fs'; readFileSync(String.raw`docs/api\\x2e.md`);\n");
  box.put('test/template-identity.test.js',"import {readFileSync} from 'node:fs'; readFileSync(`docs/\\X63.md`);\n");
  const base = box.commit();
  box.put('docs/api.md','# Updated API\n');
  box.put('docs/api\\x2e.md','# Raw template path\n');
  box.put('docs/X63.md','# Identity escape path\n');
  box.put('docs/api..md','# Conservatively cooked raw-tag path\n');
  const commit = box.commit();
  assert.deepEqual(selectAffectedTests(box.root,{base,commit,changed:['docs/api.md']}).files,
    ['docs/api.test.js','test/template-hex.test.js','test/template-identity.test.js','test/template-point.test.js','test/template-raw.test.js','test/template-unicode.test.js'],
    'plain-text docs and .md markers conservatively include every matching source');
  assert.deepEqual(selectAffectedTests(box.root,{base,commit,changed:['docs/api\\x2e.md']}).files,
    ['test/template-identity.test.js','test/template-raw.test.js'],'plain-text markers may select more than the raw-tag reader');
  assert.deepEqual(selectAffectedTests(box.root,{base,commit,changed:['docs/api..md']}).files,
    ['test/template-identity.test.js','test/template-raw.test.js'],'plain-text markers retain both raw and identity readers');
  assert.deepEqual(selectAffectedTests(box.root,{base,commit,changed:['docs/X63.md']}).files,
    ['test/template-identity.test.js','test/template-raw.test.js'],'plain-text markers conservatively include both readers');
});


test('a docs path built inline still selects its reader [V4,C7]', (t) => {
  const box = graph(t);
  box.put('test/array-reader.test.js', `import {readFileSync} from 'node:fs'; readFileSync(new URL(['..','docs','api.md'] /* docs input */ .join('/'),import.meta.url),'utf8');\n`);
  box.put('test/inline-join.test.js', "import {readFileSync} from 'node:fs'; import {join} from 'node:path'; const root='.',name='api.md'; readFileSync(join(root,'docs',name),'utf8');\n");
  box.put('test/inline-template.test.js', "import {readFileSync} from 'node:fs'; readFileSync(`do\\x63s/api.md`,'utf8');\n");
  box.put('test/comment-only-reader.test.js', "// Reads api.md by name only; no path syntax here.\n");
  box.put('test/marker-only-reader.test.js', "// docs tree readers can consume .md files after path expansion.\n");
  box.put('test/marker-helper.js', "// docs roots and .md files feed this helper.\n");
  box.put('test/transitive-marker-reader.test.js', "import './marker-helper.js';\n");
  box.put('test/unrelated.test.js', "import assert from 'node:assert/strict'; assert.ok('no document inputs');\n");
  box.put('test/embedded-name.test.js', "import assert from 'node:assert/strict'; assert.ok('notapi.md');\n");
  box.put('test/underscore-prefix.test.js', "import assert from 'node:assert/strict'; assert.ok('_api.md');\n");
  box.put('test/underscore-suffix.test.js', "import assert from 'node:assert/strict'; assert.ok('api.md_suffix');\n");
  box.put('test/unicode-prefix.test.js', "import assert from 'node:assert/strict'; assert.ok('éapi.md');\n");
  box.put('test/unicode-suffix.test.js', "import assert from 'node:assert/strict'; assert.ok('api.mdé');\n");
  box.put('test/unicode-mark-prefix.test.js', "import assert from 'node:assert/strict'; assert.ok('éapi.md');\n");
  box.put('test/unicode-mark-suffix.test.js', "import assert from 'node:assert/strict'; assert.ok('api.md́');\n");
  const base = box.commit();
  box.put('docs/api.md','# Updated API\n');
  const commit = box.commit();
  // Process-level: runs the committed reader test as its own node process to prove it passes as written.
  const reader = runFixtureChild(process.execPath, [join(box.root,'test/array-reader.test.js')], { cwd:box.root, encoding:'utf8' });
  assert.equal(reader.status,0,reader.failure ?? reader.stderr?.toString('utf8') ?? 'the committed array reader did not run');
  assert.deepEqual(selectAffectedTests(box.root,{base,commit}).files,
    ['docs/api.test.js','test/array-reader.test.js','test/comment-only-reader.test.js','test/inline-join.test.js','test/inline-template.test.js','test/marker-only-reader.test.js','test/transitive-marker-reader.test.js'],
    'a joined literal array must retain its documentation reader');
  const selected = selectAffectedTests(box.root,{base,commit,changed:['docs/api.md']}).files;
  assert.ok(selected.includes('test/comment-only-reader.test.js'), 'a basename in a comment still selects its reader');
  assert.ok(selected.includes('test/marker-only-reader.test.js'), 'the docs and .md text markers select a reader without the changed basename');
  assert.ok(selected.includes('test/transitive-marker-reader.test.js'), 'a matching imported helper selects its test');
  assert.ok(!selected.includes('test/unrelated.test.js'), 'a file without either documentation marker stays out');
  assert.ok(!selected.includes('test/embedded-name.test.js'), 'a filename embedded inside another word does not count');
  assert.ok(!selected.includes('test/underscore-prefix.test.js'), 'an underscore before the basename prevents a whole-word match');
  assert.ok(!selected.includes('test/underscore-suffix.test.js'), 'an underscore after the basename prevents a whole-word match');
  assert.ok(!selected.includes('test/unicode-prefix.test.js'), 'a Unicode letter before the basename prevents a whole-word match');
  assert.ok(!selected.includes('test/unicode-suffix.test.js'), 'a Unicode letter after the basename prevents a whole-word match');
  assert.ok(!selected.includes('test/unicode-mark-prefix.test.js'), 'a combining mark before the basename prevents a whole-word match');
  assert.ok(!selected.includes('test/unicode-mark-suffix.test.js'), 'a combining mark after the basename prevents a whole-word match');
});

test('a test that spawns the CLI is selected by what the CLI imports [C7]', (t) => {
  const box = graph(t);
  box.put('apps/cli/pullboard.js', "import './src/cli.js';\n");
  box.put('apps/cli/src/cli.js', "import './serve.js';\n");
  box.put('apps/cli/src/serve.js', "import './io/cockpit.js';\n");
  box.put('apps/cli/src/io/cockpit.js', 'export const version = 1;\n');
  box.put('src/unrelated.js', 'export const value = 1;\n');
  box.put('apps/cli/tests/fixtures/cockpit/harness.js', "const BIN = 'apps/cli/pullboard.js';\n");
  box.put('apps/cli/journeys/withdraw/items.test.js', "import '../../tests/fixtures/cockpit/harness.js';\n");
  box.put('test/direct-cli.test.js', "const BIN = 'apps/cli/pullboard.js';\n");
  const base = box.commit();

  box.put('apps/cli/src/io/cockpit.js', 'export const version = 2;\n');
  const commit = box.commit();
  const changedCockpit = selectAffectedTests(box.root, { base, commit });
  assert.equal(changedCockpit.full, false, 'the imported CLI dependency keeps focused selection');
  assert.ok(changedCockpit.files.includes('test/direct-cli.test.js'), 'a test naming the direct CLI child is selected');
  assert.ok(changedCockpit.files.includes('apps/cli/journeys/withdraw/items.test.js'), 'a test importing the CLI-launching fixture is selected transitively');

  box.put('src/unrelated.js', 'export const value = 2;\n');
  const unrelatedCommit = box.commit();
  const unrelated = selectAffectedTests(box.root, { base: commit, commit: unrelatedCommit });
  assert.equal(unrelated.full, false);
  assert.ok(!unrelated.files.includes('test/direct-cli.test.js'), 'an unrelated source change does not select a direct CLI test');
  assert.ok(!unrelated.files.includes('apps/cli/journeys/withdraw/items.test.js'), 'an unrelated source change does not select a fixture caller');

  box.put('apps/cli/src/cli.js', 'export const uncommitted = true;\n');
  const committedGraph = selectAffectedTests(box.root, { base, commit });
  assert.deepEqual(committedGraph.files, changedCockpit.files, 'selection ignores uncommitted source bytes');
});

test('the browser launch guard keeps affected selection exact [C7,O5]', (t) => {
  const box = graph(t);
  copyPackageSubset(fileURLToPath(new URL('../../../../../', import.meta.url)), box.root,
    [{ path: 'packages/gate/src/io/browser/guard.js' },
      { path: 'packages/kernel/src/logic/refused.js', as: 'src/refused.js' }]);
  const guardBody = 'packages/gate/src/io/browser/guard.js';
  box.put('test/browser-guard.test.js', `import '../${guardBody}';\n`);
  box.put('test/guard-consumer.test.js', "import './browser-guard.test.js';\n");
  const base = box.commit();
  appendFileSync(join(box.root, guardBody), '\n// A committed change to the actual guard.\n');
  const commit = box.commit();
  const selected = selectAffectedTests(box.root, { base, commit });
  assert.equal(selected.full, false, selected.reason);
  assert.deepEqual(selected.files, ['test/browser-guard.test.js', 'test/guard-consumer.test.js'],
    'the real guard retains its direct and transitive readers without selecting unrelated tests');

  const unknown = [
    "import { createRequire } from 'node:module';\n",
    "import module from 'node:module';\n",
    "import * as module from 'node:module';\n",
    "import { register } from 'node:module';\n",
    "import { syncBuiltinESMExports, createRequire } from 'node:module';\n",
    "export { syncBuiltinESMExports } from 'node:module';\n",
    "import { syncBuiltinESMExports } from 'node:module'; export const later = () => import('node:module');\n",
    "import { syncBuiltinESMExports } from 'node:module'; const loader = process.getBuiltinModule('node:util');\n",
    "import * as module from 'node:module'; const fake = \"import { syncBuiltinESMExports } from 'node:module';\";\n",
  ];
  for (const source of unknown) {
    box.put(guardBody, source);
    const unsafe = box.commit();
    const fallback = selectAffectedTests(box.root, { base: commit, commit: unsafe });
    assert.equal(fallback.full, true, source + ' must keep the conservative full-suite fallback');
    assert.match(fallback.reason, /CommonJS/u, 'the fallback names the unresolved module-loader boundary');
  }
});

test('a change to one test file selects only what reads it [V4,C7]', (t) => {
  const box = graph(t);
  // A computed import whose target the file declares: it reads src/api.js and nothing else.
  box.put('test/loader.test.js', "/** @pullboard-test-loads src/api.js */\nconst name = 'api';\nawait import(new URL(`../src/${name}.js`, import.meta.url).href);\n");
  const base = box.commit();
  box.put('test/api.test.js', "import '../src/api.js'; // one test file changed\n");
  let commit = box.commit();
  let selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false, 'a change to one test file keeps focused selection');
  assert.deepEqual(selection.files, ['test/api.test.js'], 'an unrelated computed-import test is not selected');

  box.put('src/api.js', 'export const version = 2;\n');
  commit = box.commit();
  selection = selectAffectedTests(box.root, { base, commit, changed: ['src/api.js'] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/api.test.js', 'test/loader.test.js'], 'the declared reader of a changed module is selected');

  selection = selectAffectedTests(box.root, { base, commit, changed: ['src/labels.js'] });
  assert.deepEqual(selection.files, ['test/unrelated.test.js'], 'a module it does not declare leaves the loader out');

  // A computed import with no declaration still reads what its literal path names.
  box.put('test/literal.test.js', "await import(new URL('../src/labels.js', import.meta.url).href);\n");
  commit = box.commit();
  selection = selectAffectedTests(box.root, { base, commit, changed: ['src/labels.js'] });
  assert.deepEqual(selection.files, ['test/literal.test.js', 'test/unrelated.test.js'], 'a literal path names the module the import reads');
  selection = selectAffectedTests(box.root, { base, commit, changed: ['src/api.js'] });
  assert.deepEqual(selection.files, ['test/api.test.js', 'test/loader.test.js'], 'the literal reader is left out of an unrelated change');

  // A computed import that declares nothing cannot be read, so that file always runs and says why; the rest stay focused.
  box.put('test/guess.test.js', 'await import(process.env.GUESS);\n');
  commit = box.commit();
  selection = selectAffectedTests(box.root, { base, commit, changed: ['test/api.test.js'] });
  assert.equal(selection.full, false, 'one unreadable test never forces the whole suite');
  assert.deepEqual(selection.files, ['test/api.test.js', 'test/guess.test.js'], 'the unreadable test runs beside the selection, nothing else');
  assert.match(selection.reason, /test\/guess\.test\.js/u, 'the selection names the file that cannot be read');

  // A test importing the unreadable test reaches what it reads, so it runs too.
  box.put('test/uses-guess.test.js', "import './guess.test.js';\n");
  commit = box.commit();
  selection = selectAffectedTests(box.root, { base, commit, changed: ['test/api.test.js'] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/api.test.js', 'test/guess.test.js', 'test/uses-guess.test.js'], 'an importer of the unreadable test runs with it');
});

test('an undeclared non-literal specifier, through a helper or a path builder, always runs its own file [V4,C7]', (t) => {
  for (const loader of [
    "function pick(fallback) { return process.env.CASE_MODULE || fallback; }\nawait import(new URL(pick('../src/api.js'), import.meta.url).href);\n",
    "const helpers = { pick: (fallback) => process.env.CASE_MODULE || fallback };\nawait import(new URL(helpers.pick('../src/api.js'), import.meta.url).href);\n",
    // A path builder is a call too: without a declaration even join(dir, literal) is not resolved (#803's refrozen bar).
    "import { join } from 'node:path';\nconst dir = process.env.CASE_DIR ?? '..';\nawait import(join(import.meta.dirname, dir, 'src/api.js'));\n",
  ]) {
    const box = graph(t);
    box.put('src/b.js', 'export const value = 1;\n');
    // What pick returns is decided at run time, so its literal argument does not bound what the loader reads.
    box.put('test/loader.test.js', loader);
    const base = box.commit();
    box.put('src/b.js', 'export const value = 2;\n');
    const commit = box.commit();
    const selection = selectAffectedTests(box.root, { base, commit, changed: ['src/b.js'] });
    assert.equal(selection.full, false, `a helper call's result is unresolved, so its own file runs, not the whole suite: ${loader}`);
    assert.ok(selection.files.includes('test/loader.test.js'), 'the unreadable loader always runs');
    assert.match(selection.reason, /test\/loader\.test\.js/u);
  }
});

test('a computed import with an environment fallback reads every candidate, not one literal [V4,C7]', (t) => {
  const box = graph(t);
  box.put('src/b.js', 'export const value = 1;\n');
  // The loader reads src/b.js whenever CASE_MODULE names it, so the literal fallback alone is not its read set.
  box.put('test/loader.test.js', "await import(new URL(process.env.CASE_MODULE || '../src/api.js', import.meta.url).href);\n");
  const base = box.commit();
  box.put('src/b.js', 'export const value = 2;\n');
  const commit = box.commit();
  const selection = selectAffectedTests(box.root, { base, commit, changed: ['src/b.js'] });
  assert.equal(selection.full, false, 'an unresolved branch runs its own loader, never the whole suite');
  assert.ok(selection.files.includes('test/loader.test.js'), 'the loader it cannot read always runs instead of a partial read set');
  assert.match(selection.reason, /test\/loader\.test\.js/u, 'the selection names the loader it cannot read');
});

test('a declaration counts only in the header, globs expand, and literal URLs resolve as the runtime does [V4,C7]', (t) => {
  const box = graph(t);
  box.put('src/actual.js', 'export const value = 1;\n');
  box.put('src/%61ctual.js', 'export const value = "decoy";\n');
  // Declaration-looking text inside a template is not a declaration; the undeclared import falls back (#803 review).
  box.put('test/template.test.js', "const banner = `\n/** @pullboard-test-loads src/safe.js */\n`;\nawait import(process.env.TARGET ?? '../src/actual.js');\n");
  const base = box.commit();
  box.put('src/actual.js', 'export const value = 2;\n');
  const commit = box.commit();
  const hidden = selectAffectedTests(box.root, { base, commit, changed: ['src/actual.js'] });
  assert.ok(hidden.files.includes('test/template.test.js'), 'a declaration inside a template string never stops the undeclared file running');
  assert.match(hidden.reason, /test\/template\.test\.js/u, 'the selection names the undeclared file');

  // A declared glob reads every committed module it matches.
  box.put('test/template.test.js', "/** @pullboard-test-loads src/*.js */\nawait import(process.env.TARGET ?? '../src/actual.js');\n");
  // A literal URL with a percent-escape reads the decoded file, never the encoded decoy.
  box.put('test/encoded.test.js', "await import(new URL('../src/%61ctual.js', import.meta.url).href);\n");
  const declared = box.commit();
  box.put('src/actual.js', 'export const value = 3;\n');
  const after = box.commit();
  const selected = selectAffectedTests(box.root, { base: declared, commit: after, changed: ['src/actual.js'] });
  assert.equal(selected.full, false, selected.reason);
  assert.ok(selected.files.includes('test/template.test.js'), 'the declared glob src/*.js selects its reader of src/actual.js');
  assert.ok(selected.files.includes('test/encoded.test.js'), 'the percent-escaped literal reads src/actual.js, as Node loads it');

  // Glob syntax the selector cannot expand is not a usable declaration.
  box.put('test/template.test.js', "/** @pullboard-test-loads src/{a,b}.js */\nawait import(process.env.TARGET ?? '../src/actual.js');\n");
  const braces = box.commit();
  assert.ok(selectAffectedTests(box.root, { base: after, commit: braces, changed: ['src/actual.js'] }).files.includes('test/template.test.js'), 'an unexpandable glob runs its own file');
});

test('a discovered command module or engine leaf selects what reads its registry [C7,V4]', (t) => {
  const box = graph(t);
  box.put('apps/cli/pullboard.js', "import './src/cli.js';\n");
  box.put('apps/cli/src/cli.js', "import './io/commands/index.js';\nimport '../../../packages/state/src/io/machine.js';\n");
  box.put('apps/cli/src/io/commands/index.js', "const modules = (file) => import(new URL(file, import.meta.url).href);\nexport const COMMANDS = { alpha: () => modules('./alpha.js') };\n");
  box.put('apps/cli/src/io/commands/alpha.js', 'export function run() { return 0; }\n');
  box.put('packages/state/src/io/machine.js', "import { readFileSync } from 'node:fs';\nexport const ENGINE_VERSION = readFileSync('x-engine.js', 'utf8').length;\n");
  box.put('packages/state/src/logic/engines/x-engine.js', 'export const X_ENGINE = 1;\n');
  box.put('src/unrelated.js', 'export const value = 1;\n');
  box.put('test/direct-cli.test.js', "const BIN = 'apps/cli/pullboard.js';\n");
  box.put('test/machine-reader.test.js', "import '../packages/state/src/io/machine.js';\n");
  box.put('test/unrelated.test.js', "import '../src/unrelated.js';\n");
  const base = box.commit();

  box.put('apps/cli/src/io/commands/alpha.js', 'export function run() { return 1; }\n');
  const commandCommit = box.commit();
  const command = selectAffectedTests(box.root, { base, commit: commandCommit });
  assert.equal(command.full, false, command.reason);
  assert.ok(command.files.includes('test/direct-cli.test.js'), 'a changed command module selects the tests that run the CLI');
  assert.ok(!command.files.includes('test/unrelated.test.js'), 'and nothing unrelated');

  box.put('packages/state/src/logic/engines/x-engine.js', 'export const X_ENGINE = 2;\n');
  const engineCommit = box.commit();
  const engine = selectAffectedTests(box.root, { base: commandCommit, commit: engineCommit });
  assert.equal(engine.full, false, engine.reason);
  assert.ok(engine.files.includes('test/machine-reader.test.js'), 'a changed engine leaf selects the tests that import machine.js');
  assert.ok(!engine.files.includes('test/unrelated.test.js'), 'and nothing unrelated');
});

test('runtime discovery and the selector agree on which files are engines and commands [C7,V4]', (t) => {
  const box = graph(t);
  box.put('packages/state/src/io/machine.js', "import { readFileSync } from 'node:fs';\nexport const ENGINE_VERSION = readFileSync('x-engine.js', 'utf8').length;\n");
  box.put('apps/cli/src/io/commands/index.js', "const modules = (file) => import(new URL(file, import.meta.url).href);\nexport const COMMANDS = { alpha: () => modules('./alpha.js') };\n");
  box.put('test/reader.test.js', "import '../packages/state/src/io/machine.js';\n");
  box.put('test/commands.test.js', "import '../apps/cli/src/io/commands/index.js';\n");
  box.put('test/unrelated.test.js', 'export const value = 1;\n');
  let base = box.commit();
  for (const [file, reader] of [['packages/state/src/logic/engines/check-alpha-engine.js', 'test/reader.test.js'], ['packages/state/src/logic/engines/check.alpha-engine.js', 'test/reader.test.js'],
    ['apps/cli/src/io/commands/beta.js', 'test/commands.test.js'], ['apps/cli/src/io/commands/gamma.delta.js', 'test/commands.test.js']]) {
    box.put(file, 'export const ENGINE = 1;\n');
    const commit = box.commit();
    const selected = selectAffectedTests(box.root, { base, commit });
    assert.ok(selected.full || selected.files.includes(reader), `${file} reaches ${reader} or falls back to the full suite, never selects nothing`);
    base = commit;
  }
});


test('a src change selects only its importers despite run-tests.js [V4,C7]', (t) => {
  const box = graph(t);
  const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  // Real source modules declare committed data inputs too; copy their complete tracked source/input tree.
  // The runner reader imports the app launcher, which hands the gate engine its loaders, so the copy carries the launcher too.
  const sourceInputs = packageFiles(sourceRoot).filter(path => path === 'apps/cli/src/io/run/tests.js' || (/^(?:src|bin|packages)\//u.test(path) && !/(?:^|\/)tests?\//u.test(path)));
  copyPackageFiles(sourceRoot, box.root, { files: sourceInputs });
  box.put('test/api.test.js', "import assert from 'node:assert/strict'; assert.ok(true);\n");
  box.put('apps/cli/journeys/spec/person.test.js', "import '../../../../src/config.js';\n");
  box.put('test/runner-reader.test.js', "import '../apps/cli/src/io/run/tests.js';\n");
  box.put('test/unrelated.test.js', "import assert from 'node:assert/strict'; assert.ok(true);\n");
  const base = box.commit();
  const mapped = mappedWorkingSource(sourceRoot, 'src/config.js');
  // The helper copy already installed the mapped shim at this path; the ordinary change appends to it rather than copying tool bytes.
  assert.equal(mapped.shimPath, 'src/config.js');
  appendFileSync(join(box.root, mapped.shimPath), '\n// ordinary source change\n');
  const commit = box.commit();
  const selected = selectAffectedTests(box.root, { base, commit, changed: ['src/config.js'] });
  assert.equal(selected.full, false, selected.reason);
  assert.deepEqual(selected.files, ['apps/cli/journeys/spec/person.test.js', 'test/runner-reader.test.js']);
  box.put('src/unresolved-reader.js', "import './config.js'; export const load = () => import(process.env.UNKNOWN_MODULE);\n");
  box.put('test/unresolved-reader.test.js', "import '../src/unresolved-reader.js';\n");
  const unresolved = box.commit();
  const fallback = selectAffectedTests(box.root, { base: unresolved, commit: unresolved, changed: ['src/config.js'] });
  assert.equal(fallback.full, true, 'a genuinely unresolved reached helper still requires the full suite');
  assert.match(fallback.reason, /non-literal dynamic import in reached file src\/unresolved-reader\.js/u);
});


test('repo-wide test guards survive declaration removal and use committed leading headers [C7]', t => {
  const box = graph(t);
  const header = '/** @pullboard-test-input test-tree */\n';
  box.put('test/scanner.test.js', header + 'export const scan = true;\n');
  box.put('test/text.test.js', 'const text = ' + JSON.stringify(header) + ';\n');
  const base = box.commit();
  box.put('test/scanner.test.js', 'export const scan = false;\n');
  box.put('test/new.test.js', 'export const added = true;\n');
  const commit = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit }), ['test/scanner.test.js']);
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit, changed: ['src/api.js'] }), ['test/scanner.test.js'], 'source changes retain the old explicit repo-guard obligation');
  box.put('test/text.test.js', header + 'export const dirty = true;\n');
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit }), ['test/scanner.test.js'], 'dirty declarations have no authority');
});


test('a repo guard the base names follows its file through a rename, and a deleted guard keeps its old path [C7]', t => {
  const box = graph(t), header = '/** @pullboard-test-input test-tree */\n';
  const body = Array.from({ length: 12 }, (_, index) => `export const scan${index} = ${index};\n`).join('');
  box.put('test/old-scanner.test.js', header + body);
  box.put('test/doomed.test.js', header + 'export const doomed = true;\n');
  box.put('test/other.test.js', 'export const other = true;\n');
  const base = box.commit();
  mkdirSync(join(box.root, 'packages/area/tests'), { recursive: true });
  box.git('mv', 'test/old-scanner.test.js', 'packages/area/tests/scanner.test.js');
  rmSync(join(box.root, 'test/doomed.test.js'));
  const commit = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit, changed: ['src/api.js'] }),
    ['packages/area/tests/scanner.test.js', 'test/doomed.test.js'], 'the renamed guard is read at its new path; the deleted guard keeps the old path so submit refuses it');
  box.put('packages/area/tests/scanner.test.js', body);
  const stripped = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit: stripped, changed: ['src/api.js'] }),
    ['packages/area/tests/scanner.test.js', 'test/doomed.test.js'], 'a renamed guard that drops its declaration still counts as a guard');
});

test('explicit pure repo guards cover source and test changes while behavior readers stay affected-only [C7]', t => {
  const box = graph(t), guardHeader = '/** @pullboard-test-input test-tree */\n';
  box.put('src/api.js', 'export const value = 1;\n');
  box.put('test/repo-scanner.test.js', guardHeader + 'export const scan = true;\n');
  box.put('test/behavior.test.js', '/** @pullboard-test-input source-tree */\nexport const scan = true;\n');
  box.put('test/text.test.js', 'const text = ' + JSON.stringify(guardHeader) + ';\n');
  const base = box.commit();
  box.put('src/api.js', 'export const value = 2;\n');
  const sourceCommit = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit: sourceCommit }), ['test/repo-scanner.test.js']);
  assert.ok(selectAffectedTests(box.root, { base, commit: sourceCommit }).files.includes('test/behavior.test.js'), 'real source-tree behavior remains selected by ordinary affected policy');
  box.put('test/new.test.js', 'export const added = true;\n');
  const testCommit = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base: sourceCommit, commit: testCommit }), ['test/repo-scanner.test.js']);
  box.put('test/repo-scanner.test.js', 'export const scan = false;\n');
  box.put('src/api.js', 'export const value = 3;\n');
  const removed = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base: testCommit, commit: removed, changed: ['src/api.js'] }), ['test/repo-scanner.test.js'], 'the old committed guard obligation survives removal');
  box.put('test/text.test.js', guardHeader + 'export const dirty = true;\n');
  assert.deepEqual(selectTestTreeGuards(box.root, { base: testCommit, commit: removed, changed: ['src/api.js'] }), ['test/repo-scanner.test.js'], 'dirty and string-only headers never create native obligations');
});

/** Keep only source-text scanners in the mandatory test-edit guard set. */
test('the repository test-tree guards list only source scanners and launch no browser [C7]', async () => {
  const root = join(import.meta.dirname, '../../../../..');
  const expected = [
    'packages/gate/tests/io/board/baseline/guard.test.js',
    'packages/gate/tests/io/browser/guard.test.js',
    'packages/gate/tests/io/gui/admission/guard.test.js',
    'packages/sandbox/tests/privacy/guard.test.js',
    'packages/gate/tests/logic/wait.test.js',
    'packages/gate/tests/io/test/waits.test.js',
    'packages/gate/tests/io/static/operations.test.js',
    'packages/gate/tests/io/stores.test.js',
    'packages/gate/tests/io/test/launches.test.js',
    'apps/cli/journeys/check/view.test.js',
    'packages/gate/tests/io/budgets.test.js',
  ].map(identity => mappedWorkingSource(root, identity).implementationPath).sort();
  const guards = selectTestTreeGuards(root, { commit: 'HEAD', changed: ['test/changed-input.test.js'] });
  assert.deepEqual(guards, expected, 'the committed repository guard census names every selected file');
  assert.equal(testsNeedGui(root, guards), false, 'the test-edit guard set needs no GUI session');
  assert.deepEqual(await browserBoundFiles(root, guards), [], 'no guard file declares a browser');
  const forbiddenImports = new Set(['packages/store/src/io/board.js', 'apps/view/index.js', 'src/gate.js', 'apps/cli/tests/fixtures/board.js',
    'apps/cli/tests/fixtures/e2e.js', 'apps/cli/tests/fixtures/cockpit/harness.js', 'apps/cli/tests/fixtures/chrome.js']);
  const scanFiles = [
    'packages/gate/tests/io/gui/admission/guard.test.js',
    'packages/gate/tests/io/board/baseline/guard.test.js',
    'packages/gate/tests/io/browser/guard.test.js',
    'packages/sandbox/tests/privacy/guard.test.js',
    'packages/gate/tests/logic/wait.test.js',
    'packages/gate/tests/io/test/waits.test.js',
    'apps/cli/journeys/check/view.test.js',
    'packages/gate/tests/io/budgets.test.js',
    'packages/gate/tests/io/static/operations.test.js',
    'packages/gate/tests/io/stores.test.js',
    'packages/gate/tests/io/test/launches.test.js',
  ];
  assert.equal(guards.length, 11, 'all selected guards are scanned');
  for (const guardScanFile of scanFiles) {
    assert.ok(guards.includes(guardScanFile), `${guardScanFile} is a selected guard`);
    const source = readFileSync(join(root, guardScanFile), 'utf8');
    const imports = importsIn([source])[0];
    assert.deepEqual(imports.filter(path => forbiddenImports.has(relative(root, resolve(root, dirname(guardScanFile), path)))), [], `${guardScanFile} imports no board, server or browser fixture`);
    const code = lex(source).code;
    assert.doesNotMatch(code, /\b(?:openBoard|startView|serveView|createServer|launchChromeProcess|startChrome|runFixtureChild|runProfiledShell|withGateSlot)\s*\(/u,
      `${guardScanFile} only scans source text`);
  }
});

test('gate source changes still select the static failure regression [C7]', () => {
  const root = join(import.meta.dirname, '../../../../..');
  const selection = selectAffectedTests(root, { base: 'HEAD', commit: 'HEAD', changed: ['packages/gate/src/io/main.js'] });
  assert.equal(selection.full, false, selection.reason);
  assert.ok(selection.files.includes('apps/cli/journeys/submit/gate/sandbox.test.js'),
    'the test that imports refuseSandboxBlocked stays selected for gate changes');
});

test('repo-wide test guards are found in a CommonJS project while affected tests still fall back to the full suite [C7]', t => {
  const box = graph(t);
  box.put('package.json', JSON.stringify({ name: 'plain-commonjs-project' }));
  box.put('src/api.js', 'module.exports = { value: 1 };\n');
  box.put('test/scanner.test.js', '/** @pullboard-test-input test-tree */\nrequire("../src/api.js");\n');
  box.put('test/other.test.js', 'require("../src/api.js");\n');
  const base = box.commit();
  box.put('src/api.js', 'module.exports = { value: 2 };\n');
  const commit = box.commit();
  assert.deepEqual(selectTestTreeGuards(box.root, { base, commit }), ['test/scanner.test.js'],
    'a header scan needs no ES-module graph, so a plain project is not refused');
  const selected = selectAffectedTests(box.root, { base, commit, changed: ['src/api.js'] });
  assert.equal(selected.full, true, 'the import-graph selection still refuses to guess for CommonJS');
  assert.match(selected.reason, /CommonJS/u);
});
