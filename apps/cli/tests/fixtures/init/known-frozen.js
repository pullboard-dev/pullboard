/**
 * Shared fixture for the known-main frozen journeys: a claimed item whose frozen check runs a case that is red or green on
 * main, a settled pulled submit and an independent reviewer [V4,B3,C7].
 *
 * Why shared: the journeys are split across files so each stays well under the per-file budget, since every settled
 * submit waits on a real pulled gate job.
 */
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
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../child.js';
import { fixtureSettledMachine } from '../testkit.js';
import { settleSubmit } from '../submit/settle.js';

const BIN = join(import.meta.dirname, '../../../pullboard.js');
export const FROZEN = 'node test/runner.js test/frozen.test.js';

/** Write one ordinary committed fixture input. */
export function put(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** Run the actual command with isolated identity and machine settings. */
export function cli(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Commit fixture changes normally, retaining real Git history. */
export function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test(core): frozen known main fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}

/** One real assertion whose expected value decides whether the case is red. */
export function source(expected, name = 'frozen case [G1]') {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('${name}', () => assert.equal(1, ${expected}));\n`;
}

/** A claimed item whose frozen check runs test/frozen.test.js, red on main or green on main per `main`. */
export function fixture(t, { main = 2, candidate = 2, check = FROZEN, name } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-known-frozen-')));
  // The fixture's local runner may still be finishing a main-test job as the test ends, so removal retries as it settles.
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 }));
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
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
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
  put(root, 'test/frozen.test.js', source(main, name));
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
  put(box.builder, 'test/frozen.test.js', source(candidate, name));
  box.head = commit(box, box.builder);
  return box;
}

/** Read board rows directly rather than trusting a successful exit alone. */
export function rows(box, sql, ...args) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** File an open repair whose check names the failing file. */
export function fileMainRed(box, extra = []) {
  const result = cli(box, box.root, 'add', 'core', 'Main red: frozen case needs repair', '--specs', 'G1',
    '--criterion', 'The frozen case passes on main.', '--check', FROZEN, '--brief', 'Files: test/frozen.test.js\nTest: frozen case', ...extra);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

/**
 * Submit the claimed item and wait for its pulled gate job; a pull submit returns queued at once [P7,#6249]. With
 * `submitted`, wait on until the item is submitted too: a red in main's own cases settles once main's receipts record.
 * `submission` is the recorded submit's detail, or null while none is recorded.
 */
export async function settledSubmit(t, box, { submitted = false } = {}) {
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const run = (cwd, ...args) => {
    const shown = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env: box.env, encoding: 'utf8' });
    return { code: shown.status, out: shown.stdout ?? '', err: shown.stderr ?? '' };
  };
  let shown = null;
  const until = document => { shown = document; return document?.item_status === 'submitted'; };
  // budget: under the runner's 90 s silent-hang ceiling, so a red that never settles names its thread instead of hanging.
  const settled = await settleSubmit(t, { repo: box.builder, env: box.env, run }, JSON.parse(result.stdout), submitted ? { until, deadlineMs: 75_000 } : {})
    .catch(error => { throw new Error(`${error.message.split('\n')[0]}; item ${shown?.item_status}; thread:\n${JSON.stringify((shown?.thread ?? []).slice(-6)).slice(0, 3000)}`); });
  const event = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1", box.item)[0];
  return { ...settled, submission: event ? JSON.parse(event.event_detail) : null };
}

/** Give an independent reviewer the exact submitted tree and reserve its review. */
export function reviewer(box) {
  const review = join(box.directory, 'review');
  runFixtureGit(['worktree', 'add', '-q', '--detach', review, box.head], { cwd: box.root, env: box.env });
  const independent = { ...box, env: { ...box.env, CODEX_SESSION_ID: 'known-main-independent-review' } };
  let result = cli(independent, review, 'join', 'core', '--model', 'Review Fixture');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = cli(independent, review, 'next', '--verify', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { independent, review };
}
