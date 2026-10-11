/** A red submit compares only its failed files with exact main and guides an inherited rework [V1]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Write one file under a fixture repository, creating its parent directories. */
function put(root, path, value) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

/** Run the real CLI in a private checkout and preserve its separate output streams. */
function cli(root, env, ...args) {
  const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
}

/** Commit fixture state with the isolated test identity and the requested spec citation. */
function commit(root, env, subject = 'chore: fixture state') {
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', subject], { cwd: root, env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env }).trim();
}

/** Quote one executable path for the fixture's real CLI shim. */
function shellWord(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

/** Create a private real-Git board with a selected native Node test command. */
function fixture(t, { spec, source, affectedTests = 'node test/runner.js' }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-main-red-')));
  roots.push(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Agent', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture Agent', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    PULLBOARD_MODEL: 'Fixture Model', MAIN_RED_RUNS: join(directory, 'main-runs.log'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  assert.equal(cli(root, env, 'init').code, 0);
  put(root, 'pullboard.json', JSON.stringify({
    gate: 'node test/runner.js',
    ...(affectedTests ? { affectedTests } : {}),
    lanes: { core: { owns: ['test/'], specs: ['G'] } },
  }, null, 2) + '\n');
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'SPEC.md', spec);
  put(root, 'test/inherited.test.js', source);
  put(root, 'test/runner.js', [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "if (process.env.MAIN_RED_RUNS) appendFileSync(process.env.MAIN_RED_RUNS, `${process.cwd()}\\n`);",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/inherited.test.js'];",
    "const result = spawnSync(process.execPath, ['--test', ...files], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  commit(root, env);
  return { directory, root, env };
}

/** Add each specified item through the actual coordinator CLI. */
function addItems(box, rows) {
  return rows.map(({ title, specId, route = 'mid' }) => {
    const file = { G1: 'test/inherited.test.js', G2: 'test/unrelated.test.js', G3: 'test/earlier.test.js', G4: 'test/middle.test.js' }[specId];
    const result = cli(box.root, box.env, 'add', 'core', title, '--specs', specId, '--route', route,
      '--criterion', title, '--check', 'true', '--brief', `Files: ${file}\nTest: ${title}`);
    assert.equal(result.code, 0, result.err || result.out);
    return Number(/^#(\d+)$/mu.exec(result.out)?.[1]);
  });
}

/** Create and join a real builder worktree through Pullboard. */
function builder(box) {
  const made = cli(box.root, box.env, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  const root = JSON.parse(made.out).path;
  return { root, run: (...args) => cli(root, box.env, ...args) };
}

/** Assert the public refusal identifies both next steps and excludes false unique attribution. */
function inheritedMessage(result, { row, item, testFile = 'test/inherited.test.js' } = {}) {
  assert.equal(result.code, 1, result.out || result.err);
  assert.match(result.err, /\[GATE_RED\]/u);
  assert.match(result.err, /also red on main|inherited main red/u);
  assert.match(result.err, new RegExp(testFile.replaceAll('.', '\\.'), 'u'));
  if (row && item) {
    assert.match(result.err, new RegExp(`approved row ${row} .*open rework #${item} owns it`, 'u'));
    assert.ok(result.err.trimEnd().endsWith(`next: land #${item} first, then submit again`));
  } else {
    assert.doesNotMatch(result.err, /approved row|open rework #\d+/u);
  }
}

const RED_SPEC = [
  '# Main red fixture\n\n## G · Goals',
  '- G1 [approved, must] The inherited test proves the row. | gate: test/inherited.test.js',
  '- G2 [approved, must] An unrelated change has a separate test. | gate: test/unrelated.test.js',
  '- G3 [approved, must] Earlier milestone work has a separate row. | gate: test/earlier.test.js',
  '- G4 [approved, must] Middle milestone work has a separate row. | gate: test/middle.test.js',
].join('\n') + '\n';
const FAILING_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "test('the inherited behavior remains broken [V1]', () => assert.equal(1, 2));",
].join('\n') + '\n';

test('an inherited red names the rework that owns it [V1]', async (t) => {
  await t.test('a prioritized rework already first in its tier stays first [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST });
    const [rework, submitItem] = addItems(box, [
      { title: 'First same-tier rework', specId: 'G1' },
      { title: 'Second same-tier submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): capture inherited red [G1]');
    inheritedMessage(submitter.run('submit', String(submitItem)), { row: 'G1', item: rework });
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, rework);
  });

  await t.test('one inherited row names its open owner, reuses exact-main cache, and leads only within its tier [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST });
    const [rework, submitItem, earlier, middle] = addItems(box, [
      { title: 'Repair inherited gate', specId: 'G1' },
      { title: 'Unrelated submit', specId: 'G2' },
      { title: 'Earlier light work', specId: 'G3', route: 'light' },
      { title: 'Middle milestone work', specId: 'G4' },
    ]);
    assert.ok(rework && submitItem && earlier && middle);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Middle', '--items', String(middle)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--items', String(rework)).code, 0);

    const withoutEvidence = builder(box);
    const ordinary = withoutEvidence.run('next', '--json');
    assert.equal(ordinary.code, 0, ordinary.err);
    assert.equal(JSON.parse(ordinary.out).item.item_id, earlier, 'without current-main evidence, original milestone order remains unchanged');
    const normalMid = builder(box);
    const normalOffer = normalMid.run('next', '--json');
    assert.equal(normalOffer.code, 0, normalOffer.err);
    assert.equal(JSON.parse(normalOffer.out).item.item_id, middle, 'without evidence, same-tier milestone order remains unchanged');
    assert.equal(normalMid.run('release', String(middle)).code, 0);

    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select inherited red [G1]');
    let red = submitter.run('submit', String(submitItem));
    inheritedMessage(red, { row: 'G1', item: rework });
    const main = runFixtureGit(['rev-parse', 'main'], { cwd: box.root, env: box.env }).trim();
    const common = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: submitter.root, env: box.env }).trim();
    const cachePath = join(common, 'pullboard/main-red.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.entries[main]['test/inherited.test.js'].result, 'red');
    assert.equal((readFileSync(cachePath).length > 0), true);
    assert.equal(statSync(cachePath).mode & 0o077, 0, 'the result cache is private to this machine account');
    const firstCount = readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length;
    assert.equal(firstCount, 2, 'one selected candidate run and one exact-main run occurred');

    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// second candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): retry inherited red [G1]');
    red = submitter.run('submit', String(submitItem));
    inheritedMessage(red, { row: 'G1', item: rework });
    const secondCount = readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length;
    assert.equal(secondCount, firstCount + 1, 'the second submit reuses the current-main file result');

    const afterEvidence = builder(box);
    const offered = afterEvidence.run('next', '--json');
    assert.equal(offered.code, 0, offered.err);
    assert.equal(JSON.parse(offered.out).item.item_id, rework, 'the unique main-red rework leads an earlier-milestone item within the same tier');
    const middleHolder = builder(box);
    assert.equal(middleHolder.run('claim', String(middle)).code, 0, 'a different builder can claim the non-priority same-tier item');
    assert.equal(afterEvidence.run('release', String(rework)).code, 0, 'release the selected rework before asking for another claim');
    const sole = afterEvidence.run('next', '--json');
    assert.equal(sole.code, 0, sole.err);
    assert.equal(JSON.parse(sole.out).item.item_id, rework, 'the only eligible same-tier item is never removed by prioritization');
    assert.equal(afterEvidence.run('release', String(rework)).code, 0);
    assert.equal(middleHolder.run('release', String(middle)).code, 0);
    put(box.root, 'README.md', 'A new main commit has no cached comparison yet.\n');
    const newMain = commit(box.root, box.env, 'chore: advance main fixture');
    assert.notEqual(newMain, main);
    const afterMainChange = builder(box).run('next', '--json');
    assert.equal(afterMainChange.code, 0, afterMainChange.err);
    assert.equal(JSON.parse(afterMainChange.out).item.item_id, middle, 'a cache for the former main cannot reorder the current main');
  });

  await t.test('multiple approved rows never produce a guessed row or item [V1]', (sub) => {
    const spec = [
      '# Ambiguous gate fixture\n\n## G · Goals',
      '- G1 [approved, must] First gate row. | gate: test/inherited.test.js',
      '- G2 [approved, must] Second gate row. | gate: test/inherited.test.js',
      '- G3 [approved, must] Submit row. | gate: test/unrelated.test.js',
      '- G4 [approved, must] Earlier work row. | gate: test/earlier.test.js',
    ].join('\n') + '\n';
    const box = fixture(sub, { spec, source: FAILING_TEST });
    const [first, second, earlier, submitItem] = addItems(box, [
      { title: 'First possible repair', specId: 'G1' },
      { title: 'Second possible repair', specId: 'G2' },
      { title: 'Earlier milestone work', specId: 'G4' },
      { title: 'Unrelated submit', specId: 'G3' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select ambiguous inherited red [G3]');
    const red = submitter.run('submit', String(submitItem));
    inheritedMessage(red);
    assert.doesNotMatch(red.err, new RegExp(`#${first}|#${second}`, 'u'));
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--items', `${first},${second}`).code, 0);
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, earlier, 'ambiguous rows leave next in its original milestone order');
  });

  await t.test('a row with several open owners does not prioritize either owner [V1]', (sub) => {
    const spec = [
      '# Multiple owner fixture\n\n## G · Goals',
      '- G1 [approved, must] Inherited gate row. | gate: test/inherited.test.js',
      '- G2 [approved, must] Submit row. | gate: test/unrelated.test.js',
      '- G3 [approved, must] Earlier work row. | gate: test/earlier.test.js',
    ].join('\n') + '\n';
    const box = fixture(sub, { spec, source: FAILING_TEST });
    const [first, second, earlier, submitItem] = addItems(box, [
      { title: 'First possible repair', specId: 'G1' },
      { title: 'Second possible repair', specId: 'G1' },
      { title: 'Earlier milestone work', specId: 'G3' },
      { title: 'Unrelated submit', specId: 'G2' },
    ]);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--items', `${first},${second}`).code, 0);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select multiply-owned inherited red [G2]');
    const red = submitter.run('submit', String(submitItem));
    inheritedMessage(red);
    assert.doesNotMatch(red.err, new RegExp(`#${first}|#${second}`, 'u'));
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, earlier, 'several open owners leave next in its original milestone order');
  });

  await t.test('a candidate-only red keeps the old refusal text [V1]', (sub) => {
    const green = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
    const box = fixture(sub, { spec: RED_SPEC, source: green });
    const [, submitItem] = addItems(box, [
      { title: 'Repair unrelated gate row', specId: 'G1' },
      { title: 'Candidate-only submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
    commit(submitter.root, box.env, 'test(core): introduce candidate-only red [G2]');
    const red = submitter.run('submit', String(submitItem));
    assert.equal(red.code, 1, red.out || red.err);
    assert.match(red.err, /\[GATE_RED\]/u);
    assert.doesNotMatch(red.err, /also red on main|inherited main red|main not checked/u);
  });

  await t.test('without a focused runner the old refusal names the missing config key [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST, affectedTests: '' });
    const [, submitItem] = addItems(box, [
      { title: 'Repair inherited gate', specId: 'G1' },
      { title: 'Unrelated submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select red without focused runner [G2]');
    const red = submitter.run('submit', String(submitItem));
    assert.equal(red.code, 1, red.out || red.err);
    assert.match(red.err, /\[GATE_RED\]/u);
    assert.match(red.err, /main not checked: no focused test runner configured \(affectedTests\)/u);
    assert.equal(readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length, 1, 'the main comparison does not run a second full gate');
  });
});
