/** Real Git/SQLite/CPU file workloads and a private machine pool for the #1091 process-lifetime measurement [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../../apps/cli/tests/fixtures/child.js';
import { awaitNestedRun } from '../../index.js';
import { TEST_FILE_CORES_ENV } from '../../index.js';
import { TEST_FILE_POOL_ENV } from '../../index.js';
import { GATE_SLOT_HELD_ENV } from '../../../resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../resources/index.js';
import { BROWSER_SLOT_HELD_ENV } from '../../../resources/index.js';
import { testsNeedBrowser } from '../../index.js';

const runner = fileURLToPath(new URL('../../../../apps/cli/src/io/run/tests.js', import.meta.url));

/** Make a real test file; its exit record includes startup and any post-spawn pool wait, never dispatcher queue time. */
function workload(file) {
  return `import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
process.once('exit', () => appendFileSync(process.env.FIXTURE_TIMES, JSON.stringify({
  run: process.env.FIXTURE_RUN, file: ${JSON.stringify(file)}, pid: process.pid, lifetimeMs: process.uptime() * 1000
}) + '\\n'));
test('a real Git and SQLite workload [C7]', () => {
  assert.equal(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim(), 'true');
  const db = new DatabaseSync(join(process.env.FIXTURE_DATA, process.env.FIXTURE_RUN + '-' + ${JSON.stringify(file)} + '.sqlite'));
  try {
    db.exec('CREATE TABLE value(n INTEGER); BEGIN');
    const put = db.prepare('INSERT INTO value VALUES (?)');
    for (let n = 0; n < 100; n++) put.run(n);
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT sum(n) AS total FROM value').get().total, 4950);
  } finally { db.close(); }
  assert.equal(pbkdf2Sync('private-pool-workload', 'fixed-fixture-input', 200000, 32, 'sha256').length, 32);
});
`;
}

/** Read the complete append-only lifetime observations after their owning file processes have exited. */
function observations(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Measure eight files alone and four concurrent runs of those files; fixture settings never change the user's machine. */
export async function measureFileInflation(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-dispatch-p95-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root });
  assert.equal(git.status, 0, git.failure);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ testConcurrency: { files: 8, browser: 1 } }));
  // The runner reads its policy from the committed HEAD, so the fixture needs one commit.
  for (const args of [['add', 'package.json', 'pullboard.json'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
    const step = runFixtureChild('git', args, { cwd: root });
    assert.equal(step.status, 0, step.failure);
  }
  const machine = join(root, '.machine');
  mkdirSync(machine);
  // A native run is a seat test, which leaves one slot for gates (#2831), so four of them need five slots; a landing run needs four.
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: mode === 'native' ? 5 : 4, browserSlots: 1,
    gate: { browserByLaunch: true } }));
  const times = join(root, 'lifetimes.jsonl');
  writeFileSync(times, '');
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: machine, [TEST_FILE_CORES_ENV]: '2',
    PULLBOARD_LANDING_RUN: mode === 'landing' ? '1' : '0', FIXTURE_TIMES: times, FIXTURE_DATA: root };
  // These are independently admitted private fixture runs, with their own pool and no action reuse.
  for (const key of [TEST_FILE_POOL_ENV, GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV,
    BROWSER_SLOT_HELD_ENV, 'PULLBOARD_TEST_ACTIONS', 'PULLBOARD_TEST_BROWSER_BY_LAUNCH']) delete env[key];
  const files = Array.from({ length: 8 }, (_, n) => 'work-' + n + '.test.js');
  for (const file of files) writeFileSync(join(root, file), workload(file));
  assert.equal(await testsNeedBrowser(root, files), false, 'these Git-only files declare no browser');
  const standalone = [];
  for (const file of files) {
    const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, file], {
      cwd: root, env: { ...env, FIXTURE_RUN: 'alone' },
    }));
    assert.equal(result.status, 0, result.failure ?? result.stdout);
    standalone.push({ file, status: result.status, elapsedMs: result.elapsedMs, stdout: result.stdout, stderr: result.stderr });
  }
  const alone = new Map(observations(times).map(row => [row.file, row.lifetimeMs]));
  assert.equal(alone.size, 8, 'all eight standalone file processes exited and recorded their real lifetimes');
  const runs = Array.from({ length: 4 }, (_, n) => runFixtureChildAsync(process.execPath, [runner, ...files], {
    cwd: root, env: { ...env, FIXTURE_RUN: 'concurrent-' + n },
  }));
  const parents = new Set(runs.map(run => run.child.pid));
  let peakFileProcesses = 0;
  let peakConcurrentRuns = 0;
  const db = new DatabaseSync(join(machine, 'test-file-pool.sqlite'), { readOnly: true });
  const resources = new DatabaseSync(join(machine, 'resources.sqlite'), { readOnly: true });
  // Observer lock waits are bounded custody, never changes to the process-lifetime budget.
  db.exec('PRAGMA busy_timeout = 5000');
  resources.exec('PRAGMA busy_timeout = 5000');
  let sampleError = null;
  /** Observe already spawned files, including those blocked in preload; dispatcher PIDs are not file processes. */
  const sample = () => {
    const rows = db.prepare('SELECT pid FROM file_holder UNION SELECT pid FROM file_waiter').all();
    peakFileProcesses = Math.max(peakFileProcesses, rows.filter(row => !parents.has(row.pid)).length);
    const holders = resources.prepare("SELECT pid FROM holder WHERE name = 'gate'").all();
    peakConcurrentRuns = Math.max(peakConcurrentRuns, holders.filter(row => parents.has(row.pid)).length);
  };
  const monitor = setInterval(() => {
    try { sample(); } catch (error) { sampleError ??= error; }
  }, 20); // budget: one private read every 20 ms observes overspawn; this is not a speed threshold.
  let results;
  try { results = await Promise.all(runs.map(run => awaitNestedRun(run))); sample(); }
  finally {
    clearInterval(monitor);
    // A sampling failure must not remove the fixture while its four owned runs still write there.
    await Promise.allSettled(runs);
    db.close(); resources.close();
  }
  if (sampleError) throw sampleError;
  for (const result of results) assert.equal(result.status, 0, result.failure ?? result.stdout);
  const concurrent = observations(times).filter(row => row.run.startsWith('concurrent-'));
  assert.equal(concurrent.length, 32, 'four runs of all eight real files completed without action reuse');
  const samples = concurrent.map(row => ({ ...row, standaloneMs: alone.get(row.file), ratio: row.lifetimeMs / alone.get(row.file) }));
  const ordered = samples.map(row => row.ratio).sort((a, b) => a - b);
  return { mode, cores: 2, peakFileProcesses, peakConcurrentRuns, standalone, standaloneFileLifetimes: Object.fromEntries(alone), samples,
    percentile: 'nearest rank: ceil(0.95 * 32)-1', p95: ordered[Math.ceil(0.95 * ordered.length) - 1],
    runs: results.map(result => ({ status: result.status, signal: result.signal, elapsedMs: result.elapsedMs,
      stdout: result.stdout, stderr: result.stderr })) };
}
