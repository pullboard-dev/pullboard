/** @pullboard-test-input apps/cli/src/io/commands/next.js */
/** A real next --wait on a board other seats keep writing: the CPU it burns is measured and reported, with no threshold [C7,#11794]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { createFixtureWorktree } from '../../../fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../../../pullboard.js');
const WAIT_MINUTES = '0.1';

/** Runs the real pullboard entry with the given arguments and prints the process CPU seconds it used when it exits. */
const RUN_SCRIPT = [
  "const [bin, ...args] = process.argv.slice(2);",
  "process.argv = [process.argv[0], bin, ...args];",
  "process.on('exit', () => { const used = process.cpuUsage(); process.stderr.write(`CPU_SECONDS ${(used.user + used.system) / 1e6}\\n`); });",
  "await import(process.env.PULLBOARD_WAIT_BIN_URL);",
].join('\n');

/** Writes the board file every 50 ms for 5 s without changing anything a seat can take; a separate process, so its CPU is not the wait's. */
const WRITER_SCRIPT = [
  "import { DatabaseSync } from 'node:sqlite';",
  "const db = new DatabaseSync(process.argv[2]);",
  "db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS fixture_noise (n INTEGER)');",
  "const end = Date.now() + 5000;",
  "const timer = setInterval(() => {",
  "  if (Date.now() >= end) { clearInterval(timer); db.close(); return; }",
  "  try { db.exec('INSERT INTO fixture_noise VALUES (1)'); } catch { /* a busy board skips this write */ }",
  "}, 50);",
].join('\n');

/** Start a child process and answer its exit code, output and the CPU seconds it printed. */
function child(argv, { cwd, env }) {
  return new Promise((done, fail) => {
    const proc = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.on('error', fail);
    proc.on('close', code => {
      const cpu = /CPU_SECONDS ([0-9.]+)/u.exec(err);
      done({ code, out, err, cpu: cpu ? Number(cpu[1]) : null });
    });
  });
}

test('cli.io-commands-next-wait.busy-board-cpu: clause 1: a real next --wait on a fixture board with nothing to take, while a separate process writes the board every 50 ms for 5 s, returns its idle answer without an error and reports the process CPU seconds it used [C7,#11794]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), repo = join(box.dir, 'busy-board');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal((await box.runLocal(repo, 'init')).code, 0);
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal((await box.runLocal(repo, 'lane', 'add', 'app', '--owns', 'app/')).code, 0);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the busy board');
  const made = await createFixtureWorktree(box, repo, 'app', { run: box.runLocal });
  assert.equal(made.code, 0, made.out + made.err);
  const seat = JSON.parse(made.out).path;
  const runner = join(box.dir, 'next-run.mjs'), writer = join(box.dir, 'board-writer.mjs');
  writeFileSync(runner, RUN_SCRIPT);
  writeFileSync(writer, WRITER_SCRIPT);
  const env = { ...box.env, PULLBOARD_WAIT_BIN_URL: pathToFileURL(BIN).href };
  // The cost of starting the real command and answering once, so the wait's own figure can be told from it.
  const start = await child([runner, BIN, 'next'], { cwd: seat, env });
  assert.equal(start.cpu !== null, true, start.err);
  const board = join(repo, '.git', 'pullboard', 'board.sqlite');
  const writing = child([writer, board], { cwd: box.dir, env });
  const waiting = await child([runner, BIN, 'next', '--wait', WAIT_MINUTES], { cwd: seat, env });
  const wrote = await writing;
  assert.equal(wrote.code, 0, wrote.err);
  assert.doesNotMatch(waiting.err, /\n\s+at [^\n]*\.js:\d+|Error:/u, `the wait ended in an error: ${waiting.err}`);
  assert.ok(waiting.code === 0 || waiting.code === 1, `exit ${waiting.code}: ${waiting.err}`);
  assert.equal(waiting.cpu !== null, true, waiting.err);
  const figure = Math.round((waiting.cpu - start.cpu) * 100) / 100;
  t.diagnostic(`next --wait under board writes: process CPU ${waiting.cpu} s in all, ${start.cpu} s for one plain next, so ${figure} s for the wait over ${Number(WAIT_MINUTES) * 60} s of writes`);
  console.log(`BUSY_BOARD_WAIT_CPU_SECONDS ${figure} (total ${waiting.cpu}, plain next ${start.cpu})`);
});
