/**
 * Submit proves its frozen item check and the import closure its change can reach; only a full
 * selection can stand in for the project gate, which still runs at landing [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { selectAffectedTests } from '../src/affected-tests.js';

const BIN = resolveBin();
const dirs = [];
const SPEC = '# Submit proof fixture\n\n## G · Goals\n- G1 [approved, must] The selected test proves the change. | gate: test\n';

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Resolve the real CLI relative to this test without importing any project dependencies. */
function resolveBin() {
  return join(import.meta.dirname, '../bin/pullboard.js');
}

/** Create a private Git repository with a deterministic identity and isolated Pullboard home. */
function privateRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-gate-')));
  dirs.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  /** Run real Git in this fixture with only the fixture's configured identity. */
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run the real local CLI, retaining JSON stdout and refusal stderr separately. */
  const run = (...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
    return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
  };
  git('init', '-q', '-b', 'main');
  assert.equal(run('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  put(root, 'SPEC.md', SPEC);
  put(root, 'package.json', '{"type":"module"}\n');
  return { dir, root, env, git, run };
}

/** Write a fixture file, creating its parent directory when needed. */
function put(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Commit the fixture state using a valid Pullboard message. */
function commitAll(box, message = 'chore: fixture state') {
  box.git('add', '-A');
  box.git('commit', '-q', '-m', message);
  return box.git('rev-parse', 'HEAD');
}

/** Seed a small import graph with three independently discoverable test files. */
function seedGraph(box) {
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'src/middle.js', "export { value } from './a.js';\n");
  put(box.root, 'src/entry.js', "export const load = () => import('./middle.js');\n");
  put(box.root, 'src/other.js', 'export const other = true;\n');
  put(box.root, 'test/a.test.js', "import '../src/entry.js';\n");
  put(box.root, 'test/b.test.js', "import '../src/other.js';\n");
  put(box.root, 'test/c.test.js', "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  return commitAll(box);
}

test('one source change selects its direct and transitive static, re-export and literal dynamic importers [V4,C7]', (t) => {
  const box = privateRepo(t);
  const base = seedGraph(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): update source [G1]');

  const selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js']);
  assert.equal(selection.reason, '');
});

test('changed tests are selected and deleting or renaming a source retains importers of its old path [V4,C7]', (t) => {
  const box = privateRepo(t);
  const base = seedGraph(box);

  put(box.root, 'test/c.test.js', "import assert from 'node:assert/strict';\nassert.ok(true, 'changed test');\n");
  let commit = commitAll(box, 'test(core): update a test [G1]');
  let selection = selectAffectedTests(box.root, { base, commit });
  assert.deepEqual(selection.files, ['test/c.test.js'], 'a changed test includes itself');

  const renameBase = commit;
  box.git('mv', 'src/a.js', 'src/renamed.js');
  commit = commitAll(box, 'refactor(core): rename a source [G1]');
  selection = selectAffectedTests(box.root, { base: renameBase, commit });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js'], 'the old source path still reaches its importer');
});

test('unknown imports and broad inputs fall back explicitly, while an all-test closure is full [V4,C7]', (t) => {
  const box = privateRepo(t);
  const base = seedGraph(box);
  put(box.root, 'src/a.js', "export const load = name => import('./' + name + '.js');\n");
  const commit = commitAll(box, 'feat(core): add dynamic loading [G1]');
  const dynamic = selectAffectedTests(box.root, { base, commit });
  assert.equal(dynamic.full, true, 'a non-literal dynamic import fails closed');
  assert.match(dynamic.reason, /dynamic|compute|select/i);

  for (const path of ['bin/run-tests.js', 'package.json', 'package-lock.json', 'src/gate.js', 'src/affected-tests.js']) {
    const broad = selectAffectedTests(box.root, { base, commit, changed: [path] });
    assert.equal(broad.full, true, `${path} requires the full gate`);
    assert.ok(broad.reason, `${path} explains the fallback`);
  }

  put(box.root, 'src/a.js', 'export const value = 3;\n');
  put(box.root, 'test/b.test.js', "import '../src/a.js';\n");
  put(box.root, 'test/c.test.js', "import '../src/a.js';\n");
  const allTestsCommit = commitAll(box, 'test(core): cover shared source [G1]');
  const allTests = selectAffectedTests(box.root, { base, commit: allTestsCommit, changed: ['src/a.js'] });
  assert.equal(allTests.full, true, 'when every test is reached, the selection is the full gate');
  assert.deepEqual(allTests.files, ['test/a.test.js', 'test/b.test.js', 'test/c.test.js']);
});

test('submit runs the frozen check and affected test only; landing and explicit gate remain full [V4,C7,V16]', (t) => {
  const box = privateRepo(t);
  const checkCommand = 'node -e "require(\'node:fs\').appendFileSync(process.env.ITEM_CHECK_MARKER, \'check\')"';
  const checkMarker = join(box.dir, 'item-check.log');
  box.env.ITEM_CHECK_MARKER = checkMarker;
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', spec: 'SPEC.md', verify: 'any', lease: '2h' }, null, 2));
  put(box.root, 'SPEC.md', SPEC);
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/a.js';",
    "appendFileSync(process.env.AFFECTED_MARKER, 'affected\\n');",
    "assert.equal(value, 2);",
  ].join('\n'));
  put(box.root, 'test/b.test.js', [
    "import assert from 'node:assert/strict';",
    "assert.fail('independent test must not block this submit');",
  ].join('\n'));
  commitAll(box);
  const added = box.run('add', 'coordinator', 'Source change', '--check', checkCommand);
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);

  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'affected-ran.log');
  box.env.AFFECTED_MARKER = marker;
  rmSync(checkMarker, { force: true });
  const stamp = join(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
  writeFileSync(stamp, 'forged-stamp-must-not-change\n');

  const submitted = box.run('submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const receipt = JSON.parse(submitted.out);
  assert.equal(receipt.id, 1);
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.gate.green, true);
  assert.equal(receipt.gate.full, false);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
  assert.equal(receipt.gate.reason, '');
  assert.equal(receipt.gate.check.command, checkCommand);
  assert.equal(receipt.gate.check.green, true);
  assert.ok(existsSync(checkMarker), 'submit executes the item check rather than merely reporting it');
  assert.equal(readFileSync(checkMarker, 'utf8'), 'check', 'the frozen item check actually ran at submit');
  assert.ok(existsSync(marker), 'submit executes the selected test rather than merely reporting it');
  assert.equal(readFileSync(marker, 'utf8'), 'affected\n', 'submit really ran the selected test despite the full-gate stamp');
  assert.equal(readFileSync(stamp, 'utf8'), 'forged-stamp-must-not-change\n', 'subset proof never writes the full-gate stamp');

  rmSync(stamp);
  const explicit = box.run('gate');
  assert.notEqual(explicit.code, 0, 'the explicit configured full gate still sees the unrelated red test');
  assert.match(`${explicit.out}\n${explicit.err}`, /gate red/);
  const remote = join(box.dir, 'remote.git');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  const landing = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: box.root, env: box.env, encoding: 'utf8', timeout: 90_000 });
  assert.notEqual(landing.status, 0, 'the landing pre-push hook still runs the full gate');
  assert.match(`${landing.stdout ?? ''}\n${landing.stderr ?? ''}`, /gate is red|not ok 2/);
  assert.equal(existsSync(stamp), false, 'neither subset nor red full gate leaves a green full-gate stamp');
});

test('submit without a frozen check reports no item check and still runs affected tests [V4,C7,V16]', (t) => {
  const box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test' }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', "import '../src/a.js'; import { appendFileSync } from 'node:fs'; appendFileSync(process.env.AFFECTED_MARKER, 'ran');\n");
  put(box.root, 'test/b.test.js', "import assert from 'node:assert/strict'; assert.fail('unrelated');\n");
  commitAll(box);
  assert.equal(box.run('add', 'coordinator', 'No frozen command').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'without-check.log');
  box.env.AFFECTED_MARKER = marker;
  const result = box.run('submit', '1', '--json');
  assert.equal(result.code, 0, result.err);
  const receipt = JSON.parse(result.out);
  assert.match(receipt.gate.report, /no item check/u);
  assert.equal(receipt.gate.check.checked, false);
  assert.equal(receipt.gate.full, false);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
  assert.ok(existsSync(marker), 'the affected test ran without an item check');
  assert.equal(readFileSync(marker, 'utf8'), 'ran');
});

test('a red frozen item check refuses submit before affected tests run [V4,C7,V16]', (t) => {
  const box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test' }));
  seedGraph(box);
  const added = box.run('add', 'coordinator', 'Frozen check', '--check', 'node -e "process.exit(process.env.CHECK_REFUSE ? 1 : 0)"');
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): update selected source [G1]');
  box.env.CHECK_REFUSE = '1';
  const refused = box.run('submit', '1');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err, /GATE_RED/u);
  assert.match(refused.err, /item check red/u);
});


test('CommonJS and nested package scopes fall back instead of silently missing require edges [V4,V16]', (t) => {
  const common = privateRepo(t);
  put(common.root, 'package.json', '{"type":"commonjs"}\n');
  put(common.root, 'src/a.js', 'module.exports = 1;\n');
  put(common.root, 'test/a.test.js', "require('../src/a.js');\n");
  put(common.root, 'test/b.test.js', "require('node:assert/strict').ok(true);\n");
  const base = commitAll(common);
  put(common.root, 'src/a.js', 'module.exports = 2;\n');
  const commit = commitAll(common, 'feat(core): change CommonJS source [G1]');
  const selection = selectAffectedTests(common.root, { base, commit });
  assert.equal(selection.full, true, 'require import edges cannot be silently omitted');
  assert.match(selection.reason, /CommonJS|package scope/u);

  const nested = privateRepo(t);
  seedGraph(nested);
  put(nested.root, 'legacy/package.json', '{"type":"commonjs"}\n');
  put(nested.root, 'legacy/value.js', 'module.exports = 1;\n');
  const nestedBase = commitAll(nested);
  put(nested.root, 'legacy/value.js', 'module.exports = 2;\n');
  const nestedCommit = commitAll(nested, 'feat(core): change nested CommonJS source [G1]');
  const scoped = selectAffectedTests(nested.root, { base: nestedBase, commit: nestedCommit });
  assert.equal(scoped.full, true, 'nested package policy makes a single ESM graph incomplete');
  assert.match(scoped.reason, /package scope/u);

  const esm = privateRepo(t);
  const esmBase = seedGraph(esm);
  put(esm.root, 'src/a.js', "import { createRequire } from 'node:module'; export const load = createRequire(import.meta.url);\n");
  const esmCommit = commitAll(esm, 'feat(core): create a CommonJS loader [G1]');
  const loader = selectAffectedTests(esm.root, { base: esmBase, commit: esmCommit });
  assert.equal(loader.full, true, 'a reached CommonJS loader also makes the ESM import graph incomplete');
  assert.match(loader.reason, /CommonJS/u);
});
