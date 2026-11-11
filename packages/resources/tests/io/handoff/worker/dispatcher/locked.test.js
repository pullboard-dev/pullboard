/** @pullboard-test-input source-tree */
/** The gate dispatcher survives a locked slot database, and the gate workers it started survive any dispatcher exit [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { HANDOFF_WORKER_RESOURCE } from '../../../../../index.js';
import { handoffDispatcherLog } from '../../../../../index.js';
import { queueHandoffLaunch } from '../../../../../index.js';
import { reserveHandoffTicket } from '../../../../../index.js';
import { takeResource } from '../../../../../index.js';
import { temporaryDirectory } from '../../../../../../../apps/cli/tests/fixtures/board.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

/** How long the test holds the resources database lock: past the 10 s a slot write waits before SLOT_DB_LOCKED. */
const HOLD_MS = 15_000;

const DISPATCHER = fileURLToPath(new URL('../../../../../../../apps/lib/src/io/handoff/dispatcher.js', import.meta.url));

/**
 * A stand-in gate driver: it records its pid beside its request, blocks reading its job's pipe until the test lets its
 * gate finish, then writes its verdict and exits, as a gate driver records a result and ends.
 */
const WORKER = `const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[2]);
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
fs.readFileSync(path.join(dir, 'go'));
fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ green: true, pid: process.pid }));
`;

/**
 * The real dispatcher loop (runDispatcher in apps/lib/src/io/handoff/dispatcher.js) in a process of its own. The fixture
 * has no board, so the job row and the gate admission are stand-ins; the drain, the slot database and the worker
 * launches are the shipped ones.
 */
const RUN = `const { runDispatcher } = await import(${JSON.stringify(pathToFileURL(DISPATCHER).href)});
const row = { renew() {}, release() {}, retake() { return false; }, withDb() {} };
await runDispatcher({ row, admission: { admit() {}, spawned() {}, unstarted() {}, entry: null }, onPass() {}, retryMs: 200 });
`;

/** The same loop with an admission that finds every gate stale, as one whose item was released or replaced does; it records what it ends unstarted. */
const RUN_STALE = `import { appendFileSync } from 'node:fs';\n${RUN}`.replace('admit() {}', `admit() { throw Object.assign(new Error('gate no longer serves its item'), { code: 'GATE_STALE' }); }`)
  .replace('unstarted() {}', `unstarted(launch, reason) { appendFileSync(process.env.STALE_LOG, launch.job + ' ' + reason.code + '\\n'); }`);

/** A private machine home and captured tools tree holding the stand-in driver; the test process uses the same home. */
function fixture(t) {
  const dir = realpathSync(temporaryDirectory('pullboard-dispatcher-locked-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  const children = [];
  t.after(() => {
    for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* already ended */ } }
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, tools, home: process.env.PULLBOARD_MACHINE_HOME, children };
}

/** Queue one launch ticket for a fresh job directory, returning that directory. */
async function queueJob(box, id) {
  const directory = join(box.dir, 'jobs', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: id }) + '\n');
  // The gate finishes when the test writes this pipe; the driver blocks on it until then.
  assert.equal(spawnSync('mkfifo', [join(directory, 'go')]).status, 0, 'the job pipe is made');
  queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job: id }, await reserveHandoffTicket(id));
  return directory;
}

/** Start the dispatcher process on the fixture's machine home; resolves its exit code through `exited`. */
function startDispatcher(box, run = RUN) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', run], { cwd: box.dir, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PULLBOARD_MACHINE_HOME: box.home, STALE_LOG: join(box.dir, 'stale.log') } });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  box.children.push(child.pid);
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') })));
  return { child, exited };
}

/** Let one stand-in gate finish: write its pipe, which its blocked driver is reading. */
function finishGate(directory) { writeFileSync(join(directory, 'go'), 'go'); }

/** Whether a process answers. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The pids holding worker slots in the machine pool, as recorded now; an unreadable pool reads as none. */
function holderPids(box) {
  let db;
  try {
    db = new DatabaseSync(join(box.home, 'resources.sqlite'), { readOnly: true });
    return db.prepare('SELECT pid FROM holder WHERE name = ?').all(HANDOFF_WORKER_RESOURCE).map(row => row.pid);
  } catch { return []; } finally { db?.close(); }
}

/** The worker-slot holders after a pool write, which discards every holder whose process has ended. */
async function workerHolders(box) {
  const probe = await takeResource({ name: 'dispatcher-test-probe', capacity: 1, scope: 'machine', agent: 'probe' });
  probe.release();
  return holderPids(box);
}

/** The dispatcher log text, empty before its first line. */
function dispatcherLog() { return existsSync(handoffDispatcherLog()) ? readFileSync(handoffDispatcherLog(), 'utf8') : ''; }

test('clause 1: a dispatcher whose resources database is locked for 15 seconds mid-drain keeps running and launches the next gate [C7]', { timeout: 90_000 }, async t => {
  const box = fixture(t);
  const first = await queueJob(box, 'job1');
  const dispatcher = startDispatcher(box);
  await waitForCondition(() => existsSync(join(first, 'pid')), 'the first gate worker to start', { signal: t.signal });
  // Another writer holds the resources database for 15 s, past the 10 s every slot write waits before SLOT_DB_LOCKED,
  // and at least until the dispatcher has met the lock.
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  const heldAt = performance.now();
  await waitForCondition(() => performance.now() - heldAt >= HOLD_MS && /SLOT_DB_LOCKED/u.test(dispatcherLog()),
    'the lock held for 15 s and met by the dispatcher', { signal: t.signal });
  db.exec('COMMIT');
  db.close();
  assert.equal(dispatcher.child.exitCode, null, 'the dispatcher is still running after the lock');
  assert.match(dispatcherLog(), /SLOT_DB_LOCKED/u, 'the dispatcher met the locked database mid-drain');
  assert.doesNotMatch(dispatcherLog(), /dispatcher failed/u, 'the lock never ended the dispatcher');
  // The same dispatcher carries on: a gate queued after the lock starts, and both gates reach their verdicts.
  const second = await queueJob(box, 'job2');
  await waitForCondition(() => existsSync(join(second, 'pid')), 'the second gate worker to start after the lock', { signal: t.signal });
  finishGate(first);
  finishGate(second);
  await waitForCondition(() => existsSync(join(first, 'verdict.json')) && existsSync(join(second, 'verdict.json')), 'both verdicts', { signal: t.signal });
  const end = await dispatcher.exited;
  assert.equal(end.code, 0, `the dispatcher drained its queue and ended normally: ${end.stderr}`);
});

test('clause 2: a gate worker keeps running and reaches its verdict when the dispatcher is killed mid-gate, and keeps its slot until it ends [C7]', { timeout: 60_000 }, async t => {
  const box = fixture(t);
  const job = await queueJob(box, 'job1');
  const dispatcher = startDispatcher(box);
  await waitForCondition(() => existsSync(join(job, 'pid')), 'the gate worker to start', { signal: t.signal });
  const worker = Number(readFileSync(join(job, 'pid'), 'utf8'));
  // The dispatcher takes the worker's slot, then names the worker its holder.
  await waitForCondition(() => holderPids(box).includes(worker), 'the worker to hold its own slot', { signal: t.signal });
  dispatcher.child.kill('SIGKILL');
  const end = await dispatcher.exited;
  assert.equal(end.signal, 'SIGKILL', 'the dispatcher process is gone');
  assert.ok(alive(worker), 'the gate worker outlives its dispatcher');
  assert.deepEqual(await workerHolders(box), [worker], 'the worker\'s slot stays held while it runs, so a successor cannot start a second worker in it');
  finishGate(job);
  await waitForCondition(() => existsSync(join(job, 'verdict.json')), 'the gate to reach its verdict', { signal: t.signal });
  assert.deepEqual(JSON.parse(readFileSync(join(job, 'verdict.json'), 'utf8')), { green: true, pid: worker });
  await waitForCondition(() => !alive(worker), 'the worker to end after its verdict', { signal: t.signal });
  assert.deepEqual(await workerHolders(box), [], 'the slot is freed once the worker ends');
});

test('clause 3: a queued gate that no longer serves its item ends unstarted at once and the dispatcher frees itself [C7]', { timeout: 60_000 }, async t => {
  const box = fixture(t);
  await queueJob(box, 'stale1');
  const end = await startDispatcher(box, RUN_STALE).exited;
  assert.equal(end.code, 0, `the dispatcher drained its queue and ended normally: ${end.stderr}`);
  assert.equal(readFileSync(join(box.dir, 'stale.log'), 'utf8'), 'stale1 GATE_STALE\n', 'the stale gate was ended unstarted, once');
  assert.doesNotMatch(dispatcherLog(), /not admitted/u, 'a stale gate is never retried on the next pass');
});
