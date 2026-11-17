/** Resource writes go through one ordered queued writer, so no caller waits on the SQLite lock [C7,#3084]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { listResources } from '../../../index.js';
import { takeResource } from '../../../index.js';
import { enqueueResourceWrite } from '../../../src/io/write/queue.js';
import { enterResourceQueue } from '../../../src/io/write/queue.js';
import { resourceQueueDirectory } from '../../../src/io/write/queue.js';

/** The machine resource the dispatcher's slot takes used; any machine resource name serves this queue measure. */
const HANDOFF_WORKER_RESOURCE = 'submit-handoff-workers';
const RESOURCES = pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href;
const QUEUE = pathToFileURL(resolve(import.meta.dirname, '../../../src/io/write/queue.js')).href;

/** Give one test a private machine pool, restoring the caller's environment afterwards. */
function machinePool(t) {
  const home = privateFixtureFiles('pullboard-write-queue-').root;
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, file: join(home, 'resources.sqlite') };
}

/** Run module source in a worker thread, which has its own SQLite connection and queue state, and collect its result. */
function runWorker(home, source, workerData) {
  const script = join(home, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, source);
  return new Promise((done, fail) => {
    // A worker thread is not a test file: give it no test preload and no test-file pool, or it would claim this file's admission again.
    const env = { ...process.env, PULLBOARD_MACHINE_HOME: home };
    delete env.NODE_TEST_CONTEXT;
    delete env.PULLBOARD_TEST_FILE_POOL;
    const worker = new Worker(script, { workerData, env, execArgv: [] });
    worker.once('message', done);
    worker.once('error', fail);
  });
}

/** The value below which a share of the samples falls. */
function percentile(samples, share) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
}

test('resources.queue.queued-writes-apply-in-arrival-order: clause 1: queued writes apply in arrival order by one writer, and a release appends without waiting for a held writer [C7,#3084]', async t => {
  const { home, file } = machinePool(t);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE applied (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)');
  /** Record each queued entry in the order the writer applies it. */
  const apply = entry => db.prepare('INSERT INTO applied(label) VALUES (?)').run(entry.label);
  const leave = enterResourceQueue(file, { apply });
  // While this thread holds the writer, a second thread appends three writes; none may wait for the writer.
  const appended = await runWorker(home, `
    import { parentPort, workerData } from 'node:worker_threads';
    import { enqueueResourceWrite } from ${JSON.stringify(QUEUE)};
    const timings = [];
    for (const label of ['first', 'second', 'third']) {
      const started = performance.now();
      enqueueResourceWrite(workerData.file, { label }, { apply() { throw new Error('the held writer must apply queued writes'); } });
      timings.push(performance.now() - started);
    }
    parentPort.postMessage(timings);
  `, { file });
  // The appending thread finished while this thread held the writer, so no append waited for it.
  assert.equal(appended.length, 3);
  assert.deepEqual(db.prepare('SELECT label FROM applied').all(), [], 'nothing applies while another writer holds the queue');
  enqueueResourceWrite(file, { label: 'fourth' }, { apply });
  leave();
  assert.deepEqual(db.prepare('SELECT label FROM applied ORDER BY seq').all().map(row => row.label), ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(readdirSync(resourceQueueDirectory(file)), [], 'the writer drains the queue and gives the writer up');
  db.close();
});

test('resources.queue.a-lease-release-during-another-writer: clause 1: a lease release during another writer\'s transaction returns at once, never sees SLOT_DB_LOCKED, and lands when that writer leaves [C7,#3084]', async t => {
  const { home, file } = machinePool(t);
  const lease = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: 4, scope: 'machine', agent: 'handoff-worker' });
  /** Count the dispatcher's lease rows straight from the file, without joining the write queue. */
  const holders = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT COUNT(*) AS n FROM holder WHERE name = ?').get(HANDOFF_WORKER_RESOURCE).n; } finally { db.close(); }
  };
  const signal = new Int32Array(new SharedArrayBuffer(8));
  // Another thread holds the writer and the SQLite write lock for 300 ms, as a busy handoff worker would.
  const finished = runWorker(home, `
    import { parentPort, workerData } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    import { enterResourceQueue } from ${JSON.stringify(QUEUE)};
    const db = new DatabaseSync(workerData.file);
    const applied = [];
    const leave = enterResourceQueue(workerData.file, { apply: entry => { db.prepare('DELETE FROM holder WHERE token = ?').run(entry.token); applied.push(entry.op); } });
    db.exec('BEGIN IMMEDIATE');
    Atomics.store(workerData.signal, 0, 1); Atomics.notify(workerData.signal, 0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    Atomics.store(workerData.signal, 1, 1);
    db.exec('COMMIT');
    leave();
    db.close();
    parentPort.postMessage(applied);
  `, { file, signal });
  await Atomics.waitAsync(signal, 0, 0).value;
  lease.release();
  assert.equal(Atomics.load(signal, 1), 0, 'release returned while the other writer still held the database');
  assert.equal(holders(), 1, 'the release waits in the queue, not on the SQLite lock');
  assert.deepEqual(await finished, ['release'], 'the writer that held the queue applied the release as it left');
  assert.equal(holders(), 0, 'the queued release landed');
});

// A take used to ask Git for the caller's repository root every time (~14 ms of a ~18 ms take); the root is now
// read once per directory per process, so take p99 is ~10 ms at load average ~25.
test('resources.queue.at-1-000-simulated-seats-and: clause 2: at 1,000 simulated seats and 60 handoff workers, the dispatcher\'s slot take and release return within 50 ms at p99 [C7,#3084]', async t => {
  const { home, file } = machinePool(t);
  (await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: 60, scope: 'machine', agent: 'handoff-worker' })).release();
  const db = new DatabaseSync(file);
  db.exec("INSERT INTO resource(name, capacity) VALUES ('seat', 1000)");
  const insert = db.prepare("INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat) VALUES (?, 'seat', ?, '', ?, '', ?, ?)");
  db.exec('BEGIN');
  for (let seat = 0; seat < 1000; seat++) insert.run(`seat-${seat}`, process.pid, `seat-${seat}`, new Date().toISOString(), Date.now() + 600_000);
  db.exec('COMMIT');
  db.close();
  // Fixture level: the dispatcher starts and ends 60 handoff workers against a pool holding 1,000 seat leases.
  const options = { name: HANDOFF_WORKER_RESOURCE, capacity: 60, scope: 'machine', agent: 'handoff-worker', kind: 'submit-handoff', allowCapacityGrowth: true, allowCapacityShrink: true };
  const take = [], release = [];
  for (let round = 0; round < 3; round++) {
    const leases = [];
    for (let worker = 0; worker < 60; worker++) {
      const started = performance.now();
      leases.push(await takeResource(options));
      take.push(performance.now() - started);
    }
    for (const lease of leases) {
      const started = performance.now();
      lease.release();
      release.push(performance.now() - started);
    }
  }
  assert.ok(percentile(take, 0.99) < 50, `take p99 ${percentile(take, 0.99).toFixed(1)}ms`);
  assert.ok(percentile(release, 0.99) < 50, `release p99 ${percentile(release, 0.99).toFixed(1)}ms`);
  assert.equal(listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_WORKER_RESOURCE)?.holders.length ?? 0, 0, 'every release landed');
  assert.equal(listResources({ scope: 'machine' }).find(row => row.name === 'seat').holders.length, 1000, 'the seats kept their leases');
});
