/** The machine sweep stops orphaned or over-budget test processes and never a live, in-budget run [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { elapsedMs } from '../../src/io/stale-test-sweep.js';
import { readProcesses } from '../../src/io/stale-test-sweep.js';
import { sweepAllowed } from '../../src/io/stale-test-sweep.js';
import { sweepStaleTests } from '../../src/io/stale-test-sweep.js';
import { recordStaleStops } from '../../src/io/stale-test-sweep.js';
import { recordLiveness } from '../../src/io/liveness.js';

const SLEEP = 'setTimeout(() => {}, 120000)';

/** An in-memory slot database holding just the event table the sweep writes. */
function eventDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE liveness_event (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, item TEXT NOT NULL DEFAULT \'\', pid INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT \'\')');
  return db;
}

/** The private node program of a fake test run: it reports its pid, then idles. */
const PROGRAM = 'console.log(process.pid); setTimeout(() => {}, 120000)';

/**
 * Start a node process whose command line looks like a test run and carries a private marker.
 * An orphan is started by a shell that exits at once, so the node is reparented to launchd/init.
 *
 * @returns {Promise<{ pid: number, gone: Promise<unknown> }>} The pid, and a promise that settles when the process has exited.
 */
async function startRun(marker, { orphan }) {
  const child = orphan
    ? spawn('/bin/sh', ['-c', `"${process.execPath}" -e '${PROGRAM}' bin/run-tests.js ${marker} &`], { stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn(process.execPath, ['-e', PROGRAM, 'bin/run-tests.js', marker], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit'); // armed now: the launching shell can exit before the first line arrives
  const [data] = await once(child.stdout, 'data');
  const pid = Number(String(data).trim());
  child.stdout.resume(); // flow, so the stream can end and close when the process dies
  if (orphan) await exited;
  // The run's stdout closes when the process dies, whoever owned it.
  return { pid, gone: once(child.stdout, 'close') };
}

test('clause 1: a test run whose launching process is gone is stopped and recorded with its pid, command and reason [C7]', async () => {
  const marker = `orphan-${randomUUID()}`;
  const { pid, gone } = await startRun(marker, { orphan: true });
  assert.equal((await readProcesses()).find(row => row.pid === pid)?.ppid, 1, 'the run is an orphan');
  const db = eventDb();
  try {
    const stopped = sweepStaleTests({ processes: await readProcesses(), only: row => row.command.includes(marker) });
    assert.deepEqual(stopped.map(row => row.pid), [pid]);
    recordStaleStops(db, stopped, recordLiveness);
    await gone;
    const events = db.prepare('SELECT kind, pid, detail FROM liveness_event').all();
    assert.equal(events.length, 1, 'one event');
    assert.equal(events[0].kind, 'stale-test-stopped');
    assert.equal(events[0].pid, pid);
    assert.match(events[0].detail, /run-tests\.js/u);
    assert.match(events[0].detail, /launching process is gone/u);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped by the sweep. */ } }
});

test('clause 1: a test run past its file budget plus margin is stopped and recorded [C7]', async () => {
  const marker = `late-${randomUUID()}`;
  const { pid, gone } = await startRun(marker, { orphan: false });
  const db = eventDb();
  try {
    const stopped = sweepStaleTests({ processes: await readProcesses(), only: row => row.command.includes(marker), afterMs: -1 });
    assert.deepEqual(stopped.map(row => row.pid), [pid]);
    recordStaleStops(db, stopped, recordLiveness);
    await gone;
    assert.match(db.prepare('SELECT detail FROM liveness_event').get().detail, /past its \S+ s file budget plus margin/u);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped by the sweep. */ } }
});

test('clause 2: a test run whose owner is alive and within budget is never stopped [C7]', async () => {
  const marker = `live-${randomUUID()}`;
  const { pid, gone } = await startRun(marker, { orphan: false });
  const db = eventDb();
  try {
    const stopped = sweepStaleTests({ processes: await readProcesses(), only: row => row.command.includes(marker) });
    assert.deepEqual(stopped, []);
    process.kill(pid, 0); // throws if the run was stopped
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM liveness_event').get().n, 0, 'nothing is recorded');
  } finally { process.kill(pid, 'SIGKILL'); }
});

test('clause 2: this process and its ancestors are never stopped, whatever their command line [C7]', () => {
  const processes = [{ pid: 10, ppid: 1, ageMs: 9e9, command: 'node bin/pullboard.js test a.test.js' }, { pid: 11, ppid: 10, ageMs: 9e9, command: 'node bin/run-tests.js' }];
  const stopped = [];
  assert.deepEqual(sweepStaleTests({ processes, own: 11, stop: pid => stopped.push(pid) }), []);
  assert.deepEqual(stopped, []);
});

test('ps elapsed times parse in every layout [C7]', () => {
  assert.equal(elapsedMs('05:07'), 307_000);
  assert.equal(elapsedMs('02:05:07'), 7_507_000);
  assert.equal(elapsedMs('1-02:05:07'), 93_907_000);
  assert.ok(Number.isNaN(elapsedMs('junk')));
});

test('clause 2: a process inside a test run never sweeps the machine, and a runner job is not an orphan [C7]', () => {
  assert.equal(sweepAllowed({}), true);
  for (const name of ['PULLBOARD_TEST_RUNNER_PID', 'PULLBOARD_TEST_SANDBOX', 'NODE_TEST_CONTEXT']) assert.equal(sweepAllowed({ [name]: '1' }), false, name);
  const job = { pid: 20, ppid: 1, ageMs: 1000, command: 'node /Users/person/.pullboard-runner/jobs/abc/checkout/bin/run-tests.js a.test.js' };
  assert.deepEqual(sweepStaleTests({ processes: [job], own: 99, stop: () => assert.fail('a runner job is not stopped') }), []);
});

test('#7137 clause 1: a detached pullboard test --test-run driver with parent launchd/init is never stopped [C7]', () => {
  const driver = { pid: 30, ppid: 1, ageMs: 120_000,
    command: '/Users/person/.nvm/versions/node/v22.22.2/bin/node /Users/person/repo/apps/cli/pullboard.js test --test-run 5aa66d18-0f5e-47ae-8361-f7385076e222 a.test.js' };
  const signalled = [];
  assert.deepEqual(sweepStaleTests({ processes: [driver], own: 99, stop: pid => signalled.push(pid) }), []);
  assert.deepEqual(signalled, [], 'a test-run driver is not signalled');
  // A plain orphaned pullboard test (no --test-run) is still stopped, so the exemption is only for the driver.
  const plain = { ...driver, pid: 31, command: 'node bin/pullboard.js test a.test.js' };
  assert.deepEqual(sweepStaleTests({ processes: [plain], own: 99, stop: () => {} }).map(row => row.pid), [31]);
});

test('#7137 clause 2: a shell whose command line only mentions a test command is never stopped; only node processes are [C7]', () => {
  const shells = [
    { pid: 40, ppid: 1, ageMs: 9e9, command: '/bin/zsh -c source snapshot.sh && cd repo && node --test test/a.test.js' },
    { pid: 41, ppid: 1, ageMs: 9e9, command: 'zsh -c pkill -f "node --test test/relay-sealed.test.js"' },
    { pid: 42, ppid: 1, ageMs: 9e9, command: '/bin/sh -c node bin/run-tests.js a.test.js' },
  ];
  const signalled = [];
  assert.deepEqual(sweepStaleTests({ processes: shells, own: 99, stop: pid => signalled.push(pid) }), []);
  assert.deepEqual(signalled, [], 'a shell is not signalled');
  const child = { pid: 43, ppid: 1, ageMs: 9e9, command: '/usr/local/bin/node --test test/a.test.js' };
  assert.deepEqual(sweepStaleTests({ processes: [child], own: 99, stop: () => {} }).map(row => row.pid), [43]);
});
