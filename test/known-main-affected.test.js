/** An affected (mandatory) test case that fails identically on main at the base submits as a known main red [V4,B3]. */
import '../src/cli.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS } from '../packages/kernel/src/core/discovery.js';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');
const FROZEN = 'node test/runner.js test/frozen.test.js';

/** Write one ordinary committed fixture input. */
function put(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** Run the actual command with isolated identity and machine settings. */
function cli(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Commit fixture changes normally, retaining real Git history. */
function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test(core): affected known main fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}

/** One real assertion whose expected value decides whether the case is red. */
function source(expected) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('frozen case [G1]', () => assert.equal(1, ${expected}));\n`;
}

/** A claimed item with a green frozen check whose affected test/affected.test.js is red or green on main per `main`. */
function fixture(t, { main = 2, candidate = 2, check = FROZEN } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-known-affected-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, {
    PATH: [join(directory, 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Frozen fixture', GIT_AUTHOR_EMAIL: 'frozen@example.invalid',
    GIT_COMMITTER_NAME: 'Frozen fixture', GIT_COMMITTER_EMAIL: 'frozen@example.invalid',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    CODEX_SESSION_ID: 'known-main-affected-fixture', PULLBOARD_MODEL: 'Fixture Model',
  });
  const box = { directory, root, env };
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  put(directory, 'bin/pullboard', `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(directory, 'bin/pullboard'), 0o755);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  let result = cli(box, root, 'init');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js', affectedTests: 'node test/runner.js',
    lanes: { core: { owns: ['test/', 'change.txt'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] The change works. | gate: test/frozen.test.js\n');
  put(root, 'test/frozen.test.js', source(1));
  put(root, 'test/affected.test.js', source(main).replace('frozen case', 'affected case'));
  put(root, 'test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/affected.test.js'];",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  box.main = commit(box, root);
  result = cli(box, root, 'add', 'core', 'Change behind a red affected case', '--specs', 'G1', '--route', 'mid',
    '--criterion', 'The change works.', '--check', check, '--brief', 'Files: change.txt, test/\nTest: affected known main');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  box.item = JSON.parse(result.stdout).item.item_id;
  result = cli(box, root, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  box.builder = JSON.parse(result.stdout).path;
  result = cli(box, box.builder, 'claim', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(box.builder, 'change.txt', 'The change.\n');
  if (candidate !== main) put(box.builder, 'test/affected.test.js', source(candidate).replace('frozen case', 'affected case'));
  box.head = commit(box, box.builder);
  return box;
}

/** Read board rows directly rather than trusting a successful exit alone. */
function rows(box, sql, ...args) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** File an open repair whose check names the failing affected file. */
function fileMainRed(box) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: affected case needs repair', '--specs', 'G1',
    '--criterion', 'The affected case passes on main.', '--check', 'node test/runner.js test/affected.test.js', '--brief', 'Files: test/affected.test.js\nTest: affected case');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('an affected case red identically on main with no owner submits, names it, records a fact and shouts [V4,B3]', t => {
  const box = fixture(t);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate.green, false, 'the known red stays visible in the receipt');
  assert.deepEqual(report.gate.knownMainUnowned, [{ file: 'test/affected.test.js', name: 'affected case [G1]' }], 'the receipt names the known main red');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'submit files no item');
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('unowned known main red: the submission proof')
    && entry.text.includes('test/affected.test.js') && entry.text.includes('affected case [G1]')), 'the item names the unowned file and case');
  const asked = rows(box, 'SELECT * FROM shout').filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1 && String(row.shout_text).includes('test/affected.test.js'));
  assert.equal(asked.length, 1, 'exactly one decision shout reaches the coordinator');
});

test('an open Main red repair naming the affected file is linked [V4,B3]', t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.gate.knownMainReworks.map(row => [row.file, row.item]), [['test/affected.test.js', repair]]);
  assert.equal(report.gate.knownMainUnowned, undefined);
});

test('an affected case red only on the item still refuses [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('an affected case that fails differently on the item than on main refuses [V4,B3]', t => {
  const box = fixture(t, { main: 2, candidate: 3 });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
