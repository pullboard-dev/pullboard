/** Shared real CLI fixture for exact inherited-red accounting and gate-completion waits [V4,B3]. */
/** @pullboard-test-loads apps/cli/pullboard.js */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import {
  createFixtureWorktree,
  fileFixtureItem,
} from '../testkit.js';
export const BIN = join(import.meta.dirname, '../../../pullboard.js');

/** Write one ordinary committed fixture input. */
export function put(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** Run the actual command with isolated identity and machine settings. */
export function cli(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, ...(args.includes('--json') ? [] : ['--json'])], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Commit fixture changes normally, retaining its real Git history. */
export function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test(core): inherited failure fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}

/** Produce a real assertion failure whose name and error details are independently variable. */
export function source(name = 'shared failure [G1]', expected = 2) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest(${JSON.stringify(name)}, () => assert.equal(1, ${expected}));\n`;
}

/** Build and claim one private board whose accepted main already has a named red test. */
export function fixture(t, { candidate = source(), check = 'test -f change.txt', gateSuffix = '', affectedTests = 'node test/runner.js', mainRed = true, handoff = false, waitMainRedBaseline = false, phases = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-main-red-')));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, {
    PATH: [join(directory, 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Main red fixture', GIT_AUTHOR_EMAIL: 'main-red@example.invalid',
    GIT_COMMITTER_NAME: 'Main red fixture', GIT_COMMITTER_EMAIL: 'main-red@example.invalid',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    CODEX_SESSION_ID: 'submit-main-red-fixture', PULLBOARD_MODEL: 'Fixture Model',
  });
  const box = { directory, root, env };
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  put(directory, 'bin/pullboard', `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(directory, 'bin/pullboard'), 0o755);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  let result = cli(box, root, 'init');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js' + gateSuffix,
    affectedTests, submit: { handoff }, lanes: { core: { owns: ['test/', 'change.txt'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] The unrelated change works. | gate: test/inherited.test.js\n');
  put(root, 'test/inherited.test.js', source());
  put(root, 'test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/inherited.test.js'];",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
    // With `phases`, the runner ends like apps/cli/src/io/run/tests.js: its phase line on stderr after TAP's final count (#3794).
    ...(phases ? ["process.stdout.write('', () => process.stderr.write('run-tests: phases selection 0.1s, admission 0.0s, tests 0.4s, cleanup 0.0s, total 0.5s\\n'));"] : []),
  ].join('\n') + '\n');
  box.main = commit(box, root);
  box.item = fileFixtureItem(box, root, { lane: 'core', title: 'Unrelated change', criterion: 'The unrelated change works.',
    check, route: 'mid', brief: 'Files: change.txt test/inherited.test.js\nChange: add change.txt\nTest: inherited failure accounting', args: ['--specs', 'G1'],
    run: (cwd, ...args) => cli(box, cwd, ...args) }).item_id;
  result = createFixtureWorktree(box, root, 'core', { route: 'mid', run: (cwd, ...args) => cli(box, cwd, ...args) });
  assert.equal(result.code, 0, result.out + result.err);
  box.builder = JSON.parse(result.out).path;
  result = cli(box, box.builder, 'claim', String(box.item));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  put(box.builder, 'change.txt', 'Unrelated change.\n');
  put(box.builder, 'test/inherited.test.js', candidate);
  box.head = commit(box, box.builder);
  if (mainRed) box.rework = fileMainRed(box, { wait: waitMainRedBaseline });
  return box;
}

/** File a still-open repair with the exact failing test in its declared check. */
export function fileMainRed(box, { wait = false } = {}) {
  return fileFixtureItem(box, box.root, { lane: 'core', title: 'Main red: inherited assertion needs repair', args: ['--specs', 'G1'],
    criterion: 'The inherited assertion passes on main.', check: 'node test/runner.js test/inherited.test.js',
    brief: 'Files: test/inherited.test.js\nChange: repair the assertion\nTest: inherited assertion', wait,
    run: (cwd, ...args) => cli(box, cwd, ...args) }).item_id;
}

/** Read the canonical submitted receipt rather than trusting a successful shell exit alone. */
export function submittedProof(box) {
  // @pullboard-board-file journey: observe the real CLI submission without granting gate authority.
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const row = db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(box.item);
    return row ? JSON.parse(row.event_detail) : null;
  } finally { db.close(); }
}

