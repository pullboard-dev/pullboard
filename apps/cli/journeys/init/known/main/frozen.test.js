/** A frozen-check case that fails identically on main at the base submits as a known main red [V4,B3]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS } from '../../../../../../packages/kernel/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../../../tests/fixtures/child.js';
import { openBoard } from '../../../../../lib/index.js';
import { closeBoard } from '../../../../../../packages/store/index.js';
import { submitFixture } from '../../../../tests/fixtures/board/submit.js';
import { fixtureSettledMachine } from '../../../../tests/fixtures/testkit.js';

const BIN = join(import.meta.dirname, '../../../../pullboard.js');
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
  runFixtureGit(['commit', '-q', '-m', 'test(core): frozen known main fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}

/** One real assertion whose expected value decides whether the case is red. */
function source(expected) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('frozen case [G1]', () => assert.equal(1, ${expected}));\n`;
}

/** A claimed item whose frozen check runs test/frozen.test.js, red on main or green on main per `main`. */
function fixture(t, { main = 2, candidate = 2, check = FROZEN } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-known-frozen-')));
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
    CODEX_SESSION_ID: 'known-main-frozen-fixture', PULLBOARD_MODEL: 'Fixture Model',
  });
  // A fixture's submit settles the same way whatever the machine's dispatch default is [P7].
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
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
  put(root, 'test/frozen.test.js', source(main));
  put(root, 'test/other.test.js', source(1));
  put(root, 'test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/other.test.js'];",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  box.main = commit(box, root);
  result = cli(box, root, 'add', 'core', 'Change behind a red frozen case', '--specs', 'G1', '--route', 'mid',
    '--criterion', 'The change works.', '--check', check, '--brief', 'Files: change.txt, test/\nTest: frozen known main');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  box.item = JSON.parse(result.stdout).item.item_id;
  result = cli(box, root, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  box.builder = JSON.parse(result.stdout).path;
  result = cli(box, box.builder, 'claim', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(box.builder, 'change.txt', 'The change.\n');
  put(box.builder, 'test/frozen.test.js', source(candidate));
  box.head = commit(box, box.builder);
  return box;
}

/** Read board rows directly rather than trusting a successful exit alone. */
function rows(box, sql, ...args) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** File an open repair whose check names the failing file. */
function fileMainRed(box) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: frozen case needs repair', '--specs', 'G1',
    '--criterion', 'The frozen case passes on main.', '--check', FROZEN, '--brief', 'Files: test/frozen.test.js\nTest: frozen case');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

/** Give an independent reviewer the exact submitted tree and reserve its review. */
function reviewer(box) {
  const review = join(box.directory, 'review');
  runFixtureGit(['worktree', 'add', '-q', '--detach', review, box.head], { cwd: box.root, env: box.env });
  const independent = { ...box, env: { ...box.env, CODEX_SESSION_ID: 'known-main-independent-review' } };
  let result = cli(independent, review, 'join', 'core', '--model', 'Review Fixture');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = cli(independent, review, 'next', '--verify', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { independent, review };
}

test('verify accepts an identical owned main red and records its exact case [V4,B3]', t => {
  const box = fixture(t), repair = fileMainRed(box);
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const { independent, review } = reviewer(box);
  const accepted = cli(independent, review, 'verify', String(box.item), 'accept', '--note', 'checked the frozen case');
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const event = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='accept' ORDER BY event_id DESC LIMIT 1", box.item)[0];
  const detail = JSON.parse(event.event_detail);
  assert.match(detail.note, /test\/frozen\.test\.js :: frozen case \[G1\]/u);
  assert.equal(detail.knownMainFailures.failures[0].item, repair);
  assert.equal(detail.knownMainFailures.main, box.main);
});

test('verify refuses a frozen failure that is green on main [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  fileMainRed(box);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  try {
    const tree = runFixtureGit(['rev-parse', `${box.head}^{tree}`], { cwd: box.builder, env: box.env }).trim();
    submitFixture(board, box.item, { agentId: 'core-1', commit: box.head, tree });
  } finally { closeBoard(board); }
  const { independent, review } = reviewer(box);
  const refused = cli(independent, review, 'verify', String(box.item), 'accept', '--note', 'check the head-only failure');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'CHECK_RED');
});

test('verify refuses an identical main failure without an open repair owner [V4,B3]', t => {
  const box = fixture(t);
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const { independent, review } = reviewer(box);
  const refused = cli(independent, review, 'verify', String(box.item), 'accept', '--note', 'no repair owns the case');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'CHECK_RED');
});

test('a frozen case red identically on main with no owner records a green gate listing it main-owned, shouts, and files nothing [V4,B3,C7]', t => {
  const box = fixture(t);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  // Since #3534 the gate records green over main's own reds and names them, instead of a builder fact.
  assert.equal(report.gate.green, true, 'a red only in main\'s own case records green');
  assert.deepEqual(report.gate.mainOwned.map(({ file, name }) => ({ file, name })), [{ file: 'test/frozen.test.js', name: 'frozen case [G1]' }], 'the gate names the main-owned file and case');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'submit files no item');
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.ok(!shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('unowned known main red')), 'no builder fact is written for a main-owned red');
  const shouts = rows(box, 'SELECT * FROM shout');
  const asked = shouts.filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1 && String(row.shout_text).includes('test/frozen.test.js'));
  assert.equal(asked.length, 1, 'exactly one decision shout reaches the coordinator: ' + JSON.stringify(shouts));
});

test('an open Main red repair is linked, not duplicated [V4,B3]', t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).gate.knownMainReworks.map(row => row.item), [repair]);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1);
});

test('a frozen case green on main but red on the item still refuses [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'a new failure files no main red');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a frozen case that fails differently on the item than on main refuses [V4,B3]', t => {
  const box = fixture(t, { main: 2, candidate: 3 });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a frozen check with a failing stage no case explains refuses even when its cases are known [V4,B3]', t => {
  const box = fixture(t, { check: FROZEN + '; exit 7' });
  fileMainRed(box);
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});


test('a later main red never excuses a case green at the actual item merge base [V4,B3]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const before = runFixtureChild(process.execPath, ['--test', join(box.root, 'test/frozen.test.js')],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(before.status, 0, before.stdout + before.stderr);
  put(box.root, 'test/frozen.test.js', source(2));
  const advancedMain = commit(box, box.root);
  const actualBase = runFixtureGit(['merge-base', box.head, advancedMain], { cwd: box.root, env: box.env }).trim();
  assert.equal(actualBase, box.main, 'independent trunk movement preserves the original green merge base');
  const current = runFixtureChild(process.execPath, ['--test', join(box.root, 'test/frozen.test.js')],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(current.status, 1, 'the independent current-main failure is real');
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
