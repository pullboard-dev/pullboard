/** Shared private-board fixture for the main-red journeys: a real-Git board, builders, and the inherited-red assertions. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import { settleSubmit } from '../submit/settle.js';

export const BIN = join(import.meta.dirname, '../../../pullboard.js');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Write one file under a fixture repository, creating its parent directories. */
export function put(root, path, value) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

/**
 * Run the real CLI in a private checkout and preserve its separate output streams. Why: the fixture child's `failure`
 * text folds stdout timing lines in after stderr, which would hide the refusal's closing `next:` line.
 */
export function cli(root, env, ...args) {
  const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr || result.failure || '' };
}

/** Commit fixture state with the isolated test identity and the requested spec citation. */
export function commit(root, env, subject = 'chore: fixture state') {
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', subject], { cwd: root, env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env }).trim();
}

/** Count gate and main-comparison runner calls; item-check runs, including add's baselines, are not logged. */
export function runCount(box) {
  return existsSync(box.env.MAIN_RED_RUNS) ? readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length : 0;
}

/** Quote one executable path for the fixture's real CLI shim. */
function shellWord(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

/** Create a private real-Git board with a selected native Node test command. */
export function fixture(t, { spec, source, affectedTests = 'node test/runner.js', reporter, requireInfraNote = false }) {
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
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    PULLBOARD_MODEL: 'Fixture Model', MAIN_RED_RUNS: join(directory, 'main-runs.log'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  assert.equal(cli(root, env, 'init').code, 0);
  put(root, 'pullboard.json', JSON.stringify({
    gate: 'node test/runner.js',
    ...(requireInfraNote ? { submit: { requireInfraNote: true } } : {}),
    ...(affectedTests ? { affectedTests } : {}),
    lanes: { core: { owns: ['test/'], specs: ['G'] } },
  }, null, 2) + '\n');
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'SPEC.md', spec);
  put(root, 'test/inherited.test.js', source);
  put(root, 'test/runner.js', [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    // The item check marks its own runs; only gate and main-comparison runs are counted (#2349). The log's path is written
    // in, since a pulled gate's runner does not inherit this test's environment.
    `if (process.env.MAIN_RED_STAGE !== 'check') appendFileSync(${JSON.stringify(env.MAIN_RED_RUNS)}, \`\${process.cwd()}\\n\`);`,
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/inherited.test.js'];",
    `const result = spawnSync(process.execPath, ['--test', ...${JSON.stringify(reporter ? [`--test-reporter=${reporter}`] : [])}, ...files], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });`,
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  commit(root, env);
  return { directory, root, env };
}

/** Add each specified item through the actual coordinator CLI. */
export function addItems(box, rows) {
  return rows.map(({ title, specId, route = 'mid' }) => {
    const file = { G1: 'test/inherited.test.js', G2: 'test/unrelated.test.js', G3: 'test/earlier.test.js', G4: 'test/middle.test.js' }[specId];
    const args = ['add', 'core', title, '--specs', specId, '--route', route === 'light' ? 'mid' : route,
      // These recovery cases exercise an unsatisfied item check; the extra failing stage keeps it unaccountable as a known main red (known-main-frozen.test.js covers the accountable case).
      // The submit gate now runs the proof after a red item check, and add runs each check on main as a baseline. Both invoke
      // the same runner, so the check marks its runs (MAIN_RED_STAGE=check) and the counts below see only gate and main runs;
      // --wait still lets each baseline finish before anything is counted (#2349).
      '--criterion', title, '--check', 'MAIN_RED_STAGE=check node test/runner.js; exit 1', '--brief', `Files: ${file}\nTest: ${title}`, '--wait'];
    let result = cli(box.root, box.env, ...args);
    // These items share one check command by design: answer the near-duplicate guard with the nearest id it names.
    const nearest = /DUPLICATE_LIKELY[\s\S]*?#(\d+)/u.exec(result.out + result.err)?.[1];
    if (result.code !== 0 && nearest) result = cli(box.root, box.env, ...args, '--not-duplicate-of', `${nearest} each fixture item owns a different row or role`);
    assert.equal(result.code, 0, result.err || result.out);
    const id = Number(/^#(\d+)$/mu.exec(result.out)?.[1]);
    if (route === 'light') {
      // A light item needs a capable seat's diagnosis, which routes it light; a plain add can only start mid (#2760).
      const diagnosed = cli(box.root, box.env, 'fact', String(id), 'diagnosis', `Files: ${file} Change: make the fixture test pass Test case: ${title}`);
      assert.equal(diagnosed.code, 0, diagnosed.err || diagnosed.out);
    }
    return id;
  });
}

/** Create and join a real builder worktree through Pullboard. */
export function builder(box) {
  const made = cli(box.root, box.env, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  const root = JSON.parse(made.out).path;
  return { root, run: (...args) => cli(root, box.env, ...args) };
}

/**
 * Submit a claimed item through its pulled gate and wait until the board has applied the gate's receipt and `until`
 * accepts the shown item. Why: a pull submit returns queued at once and the gate's result is the item's thread, not
 * the submit's own refusal; a red compared with main by file settles once main's receipt records [P7,C7].
 *
 * @returns {Promise<{ shown: object, job: { id: string, gate: object | null } }>}
 */
export async function settledRed(t, box, submitter, item, { args = [], until = () => true } = {}) {
  const submitted = submitter.run('submit', String(item), ...args, '--json', '--no-next');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  let shown = null;
  const run = (cwd, ...rest) => cli(cwd, box.env, ...rest);
  const settled = await settleSubmit(t, { repo: submitter.root, env: box.env, run }, JSON.parse(submitted.out), { until: doc => { shown = doc; return until(doc); } });
  return { shown, job: settled.gateJob };
}

/** The text of every fact the board recorded for one gate job's result, oldest first; the note offering the job is not one. */
export function gateFacts(shown, job) {
  return (shown?.thread ?? []).map(entry => String(entry.text ?? '')).filter(text => text.startsWith(`Gate job ${job} `) && !text.startsWith(`Gate job ${job} offered for `));
}

/** Assert the public refusal identifies both next steps and excludes false unique attribution. */
export function inheritedMessage(result, { row, item, testFile = 'test/inherited.test.js' } = {}) {
  assert.equal(result.code, 1, result.out || result.err);
  assert.match(result.err, /\[GATE_RED\]/u);
  assert.match(result.err, /also red on main|inherited main red/u);
  assert.match(result.err, new RegExp(testFile.replaceAll('.', '\\.'), 'u'));
  if (row && item) {
    assert.match(result.err, new RegExp(`approved row ${row} .*open rework #${item} owns it`, 'u'));
    assert.ok(result.err.trimEnd().endsWith(`next: land #${item} first, then submit again`));
    assert.equal((result.err.match(/^next: /gmu) ?? []).length, 1, 'the specific recovery is printed once');
  } else {
    assert.doesNotMatch(result.err, /approved row|open rework #\d+/u);
  }
}

/**
 * Drop the commit-time scope notices ("#4 may be out of scope: #1 names ...") from a refusal. Why: they name other
 * items by the files their briefs list, which says nothing about which item owns an inherited red.
 */
export function withoutScopeNotices(text) {
  return text.split('\n').filter(line => !/^#\d+ may be out of scope: /u.test(line)).join('\n');
}

export const RED_SPEC = [
  '# Main red fixture\n\n## G · Goals',
  '- G1 [approved, must] The inherited test proves the row. | gate: test/inherited.test.js',
  '- G2 [approved, must] An unrelated change has a separate test. | gate: test/unrelated.test.js',
  '- G3 [approved, must] Earlier milestone work has a separate row. | gate: test/earlier.test.js',
  '- G4 [approved, must] Middle milestone work has a separate row. | gate: test/middle.test.js',
].join('\n') + '\n';
export const FAILING_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "test('the inherited behavior remains broken [V1]', () => assert.equal(1, 2));",
].join('\n') + '\n';
