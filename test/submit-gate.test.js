/**
 * Submit proves its frozen item check and the import closure its change can reach; only a full
 * selection can stand in for the project gate, which still runs at landing [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { selectAffectedTests } from '../src/affected-tests.js';
import { configFromSource } from '../src/config.js';

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

/** Create a real joined builder while the coordinator stays on its unchanged trunk. */
function builderRepo(box) {
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { build: { owns: ['src/', 'test/'], specs: ['G'] } };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  commitAll(box);
  const made = box.run('worktree', 'build', '--json');
  assert.equal(made.code, 0, made.err);
  const root = JSON.parse(made.out).path;
  /** Run Git only in the joined builder. */
  const git = (...args) => execFileSync('git', args, { cwd: root, env: box.env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run the real CLI with the joined builder identity. */
  const run = (...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8', timeout: 90_000 });
    return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
  };
  return { ...box, root, git, run, coordinator: box.run };
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
  let box = privateRepo(t);
  const checkCommand = 'node -e "require(\'node:fs\').appendFileSync(process.env.ITEM_CHECK_MARKER, \'check\')"';
  const checkMarker = join(box.dir, 'item-check.log');
  box.env.ITEM_CHECK_MARKER = checkMarker;
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', spec: 'SPEC.md', verify: 'any', lease: '2h' }, null, 2));
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
  box = builderRepo(box);
  const added = box.coordinator('add', 'build', 'Source change', '--check', checkCommand);
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);

  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'affected-ran.log');
  box.env.AFFECTED_MARKER = marker;
  rmSync(checkMarker, { force: true });
  const stamp = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
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
  const landing = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: box.root, env: box.env, encoding: 'utf8', timeout: 90_000 });
  assert.notEqual(landing.status, 0, 'the landing pre-push hook still runs the full gate');
  assert.match(`${landing.stdout ?? ''}\n${landing.stderr ?? ''}`, /gate is red|not ok 2/);
  assert.equal(existsSync(stamp), false, 'neither subset nor red full gate leaves a green full-gate stamp');
});

test('a jest project submits with its own gate [V4,C7]', (t) => {
  for (const optedIn of [false, true]) {
    let box = privateRepo(t);
    const gateMarker = join(box.dir, `jest-gate-${optedIn}.log`);
    const testMarker = join(box.dir, `jest-tests-${optedIn}.log`);
    box.env.JEST_GATE_MARKER = gateMarker;
    box.env.JEST_TEST_MARKER = testMarker;
    if (optedIn) box.env.FAIL_UNSELECTED = '1';
    put(box.root, 'pullboard.json', JSON.stringify({
      gate: 'npm test',
      ...(optedIn ? { affectedTests: 'node test/jest-runner.js' } : {}),
    }));
    put(box.root, 'package.json', JSON.stringify({
      type: 'module',
      scripts: { test: 'node test/jest-runner.js' },
    }));
    put(box.root, 'src/a.js', 'export const value = 1;\n');
    put(box.root, 'src/b.js', 'export const value = 8;\n');
    put(box.root, 'test/jest-runner.js', [
      "import { appendFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['./test/a.test.js', './test/b.test.js'];",
      "appendFileSync(process.env.JEST_GATE_MARKER, process.argv.slice(2).length ? 'prefix\\n' : 'full\\n');",
      'const pending = [];',
      "globalThis.describe = (_name, run) => run();",
      "globalThis.it = (_name, run) => pending.push(Promise.resolve().then(run));",
      "globalThis.expect = actual => ({ toBe(expected) { if (!Object.is(actual, expected)) throw new Error(`expected ${expected}, received ${actual}`); } });",
      'for (const file of files) await import(pathToFileURL(resolve(file)));',
      'const results = await Promise.allSettled(pending);',
      'const failed = results.find(result => result.status === \'rejected\');',
      'if (failed) { console.error(failed.reason); process.exitCode = 1; }',
    ].join('\n') + '\n');
    put(box.root, 'test/a.test.js', [
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/a.js';",
      "describe('relative ESM imports', () => it('runs with jest-style globals', () => {",
      "  appendFileSync(process.env.JEST_TEST_MARKER, 'a\\n');",
      '  expect(value).toBe(2);',
      '}));',
    ].join('\n') + '\n');
    put(box.root, 'test/b.test.js', [
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/b.js';",
      "describe('relative ESM imports', () => it('runs the other configured test', () => {",
      "  if (process.env.FAIL_UNSELECTED) throw new Error('unselected test ran');",
      "  appendFileSync(process.env.JEST_TEST_MARKER, 'b\\n');",
      '  expect(value).toBe(8);',
      '}));',
    ].join('\n') + '\n');
    commitAll(box);
    box = builderRepo(box);
    const added = box.coordinator('add', 'build', 'Jest-style project', '--check', 'true');
    assert.equal(added.code, 0, added.err);
    assert.equal(box.run('claim', '1').code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): change a jest project source [G1]');

    const submitted = box.run('submit', '1', '--json');
    assert.equal(submitted.code, 0, submitted.err || submitted.out);
    const receipt = JSON.parse(submitted.out);
    if (optedIn) {
      assert.equal(receipt.gate.full, false);
      assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
      assert.equal(readFileSync(gateMarker, 'utf8'), 'prefix\n', 'the configured prefix ran the selected file');
      assert.equal(readFileSync(testMarker, 'utf8'), 'a\n', 'the unrelated test did not run');
    } else {
      assert.equal(receipt.gate.full, true);
      assert.equal(readFileSync(gateMarker, 'utf8'), 'full\n', 'the configured project gate ran without opt-in');
      assert.equal(readFileSync(testMarker, 'utf8'), 'a\nb\n', 'the full project gate ran both tests');
    }
  }
});

test('affectedTests accepts only a nonempty command prefix [V4,C7]', () => {
  for (const affectedTests of ['', '  ', 4, false, null]) {
    assert.throws(() => configFromSource(JSON.stringify({ affectedTests })), {
      code: 'BAD_CONFIG', message: /affectedTests.*nonempty command prefix/u,
    });
  }
  assert.equal(configFromSource(JSON.stringify({ affectedTests: 'node test/runner.js' })).affectedTests, 'node test/runner.js');
});

test('submit without a frozen check reports no item check and still runs affected tests [V4,C7,V16]', (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', "import '../src/a.js'; import { appendFileSync } from 'node:fs'; appendFileSync(process.env.AFFECTED_MARKER, 'ran');\n");
  put(box.root, 'test/b.test.js', "import assert from 'node:assert/strict'; assert.fail('unrelated');\n");
  commitAll(box);
  box = builderRepo(box);
  assert.equal(box.coordinator('add', 'build', 'No frozen command').code, 0);
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
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  box = builderRepo(box);
  const added = box.coordinator('add', 'build', 'Frozen check', '--check', 'node -e "process.exit(process.env.CHECK_REFUSE ? 1 : 0)"');
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


for (const mode of ['topic parent', 'merge commit']) {
  test(`affected tests include source changes carried by a ${mode} [V4,C7,V16]`, (t) => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box);
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      "appendFileSync(process.env.AFFECTED_MARKER, 'ran\\n');",
      'assert.equal(value, 1);',
    ].join('\n'));
    box = builderRepo(box);
    assert.equal(box.coordinator('add', 'build', 'Merged source', '--check', 'true').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    const branch = box.git('branch', '--show-current');
    box.git('checkout', '-q', '-b', 'topic');
    put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): topic source [G1]');
    box.git('checkout', '-q', branch);
    if (mode === 'merge commit') {
      put(box.root, 'src/other.js', 'export const other = false;\n');
      commitAll(box, 'feat(core): unrelated source [G1]');
      box.git('merge', '--no-ff', '--no-commit', 'topic');
      put(box.root, 'src/a.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): resolve merged source [G1]');
    } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic source [G1]');
    assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'the candidate really has two parents');
    const marker = join(box.dir, 'merged-test-ran.log');
    box.env.AFFECTED_MARKER = marker;
    const standalone = spawnSync(process.execPath, ['--test', 'test/a.test.js'], { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the merged source regression');
    assert.match(standalone.stdout, /ERR_ASSERTION/u);
    rmSync(marker);
    const refused = box.run('submit', '1');
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.match(refused.err, /GATE_RED/u);
    assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
    assert.match(refused.err, /ERR_ASSERTION/u);
    assert.equal(readFileSync(marker, 'utf8'), 'ran\n', 'submit actually executed the transitive importer');
  });
}

test('computed imports in test files are always selected in both graphs without forcing full [V4,C7]', (t) => {
  const box = privateRepo(t);
  const original = seedGraph(box);
  put(box.root, 'test/c.test.js', "export const load = path => import(path);\n");
  const base = commitAll(box);
  const added = selectAffectedTests(box.root, { base: original, commit: base, changed: ['src/a.js'] });
  assert.equal(added.full, false);
  assert.deepEqual(added.files, ['test/a.test.js', 'test/c.test.js'], 'the new graph also always selects its computed-import test');
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  let commit = commitAll(box, 'feat(core): source change [G1]');
  let selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js', 'test/c.test.js'], 'an unrelated computed-import test is always selected');
  selection = selectAffectedTests(box.root, { base, commit, changed: ['test/c.test.js'] });
  assert.equal(selection.full, false, 'reaching a computed-import test does not force full');
  assert.deepEqual(selection.files, ['test/c.test.js']);
  put(box.root, 'test/c.test.js', "import 'node:assert/strict';\n");
  commit = commitAll(box, 'test(core): remove computed loader [G1]');
  selection = selectAffectedTests(box.root, { base, commit, changed: ['src/a.js'] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js', 'test/c.test.js'], 'the old graph keeps its computed-import test selected');
});

test('affected selection says explicitly when no claim head was recorded [V4,C7]', (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const selection = selectAffectedTests(box.root, { base: null, trunk: 'refs/heads/main' });
  assert.equal(selection.full, true);
  assert.match(selection.reason, /no claim head recorded/u);
});


test('affected selection reads old edges and all changes at the trunk merge base [V4,C7]', (t) => {
  const box = privateRepo(t);
  const trunk = seedGraph(box);
  box.git('rm', 'src/a.js');
  const claim = commitAll(box, 'refactor(core): remove old source [G1]');
  // A claim made after the deletion and an empty receipt must not hide the trunk-relative change.
  const selection = selectAffectedTests(box.root, { base: claim, trunk, changed: [] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js']);
});


test('affected submit includes branch changes made before the item claim [V4,C7,V16]', (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  put(box.root, 'test/a.test.js', "import assert from 'node:assert/strict'; import { value } from '../src/middle.js'; assert.equal(value, 1);\n");
  box = builderRepo(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): source before claim [G1]');
  assert.equal(box.coordinator('add', 'build', 'Existing source change', '--check', 'true').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/other.js', 'export const other = false;\n');
  commitAll(box, 'feat(core): source after claim [G1]');
  const refused = box.run('submit', '1');
  assert.equal(refused.code, 1, refused.out || refused.err);
  assert.match(refused.err, /GATE_RED/u);
  assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
  assert.match(refused.err, /ERR_ASSERTION/u);
});


for (const mode of ['deleted source', 'topic parent', 'merge commit']) {
  test(`affected submit on main includes a ${mode} since its claim [V4,C7,V16]`, (t) => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', lanes: { core: { owns: ['src/', 'test/'], specs: ['G'] } } }));
    seedGraph(box);
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      "appendFileSync(process.env.AFFECTED_MARKER, 'ran\\n');",
      'assert.equal(value, 1);',
    ].join('\n'));
    commitAll(box);
    const added = box.run('add', 'coordinator', 'Main checkout source', '--check', 'true');
    assert.equal(added.code, 0, added.err);
    const claimed = box.run('claim', '1');
    assert.equal(claimed.code, 0, claimed.err);
    if (mode === 'deleted source') {
      box.git('rm', 'src/a.js');
      commitAll(box, 'refactor(core): delete source on main [G1]');
    } else {
      box.git('checkout', '-q', '-b', 'topic');
      put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): topic source [G1]');
      box.git('checkout', '-q', 'main');
      if (mode === 'merge commit') {
        put(box.root, 'src/other.js', 'export const other = false;\n');
        commitAll(box, 'feat(core): unrelated main source [G1]');
        box.git('merge', '--no-ff', '--no-commit', 'topic');
        put(box.root, 'src/a.js', 'export const value = 2;\n');
        commitAll(box, 'feat(core): resolve main merge [G1]');
      } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic into main [G1]');
      assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    }
    assert.equal(box.git('branch', '--show-current'), 'main', 'submit runs in the actual main checkout');
    const marker = join(box.dir, 'main-importer-ran.log');
    box.env.AFFECTED_MARKER = marker;
    const standalone = spawnSync(process.execPath, ['--test', 'test/a.test.js'], { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the source regression');
    assert.match(standalone.stdout, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    rmSync(marker, { force: true });
    const refused = box.run('submit', '1');
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.match(refused.err, /GATE_RED/u);
    assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
    assert.match(refused.err, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    if (mode !== 'deleted source') assert.equal(readFileSync(marker, 'utf8'), 'ran\n', 'submit executed the unchanged transitive importer');
  });
}
