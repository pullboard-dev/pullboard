/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listResources, setResourceCapacity, takeResource } from '../src/resources.js';

const TEMP = [];
const CHILDREN = new Set();
const MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/resources.js')).href;
const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/gate.js')).href;
const PROCESS_INFO_POLICY = '(version 1)(allow default)(deny process-info*)';
const SANDBOX_EXEC = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PERL_FORK = process.platform === 'darwin' && existsSync('/usr/bin/perl');
const WORKER = `
import { takeResource } from ${JSON.stringify(MODULE)};
const [name, capacity, scope, root, agent, stallMs] = process.argv.slice(1);
let lastWait = '';
const lease = await takeResource({ name, capacity: Number(capacity), scope, root, agent, onWait: ({position, holders, line, rejoined}) => {
  const state = JSON.stringify({waiting:position, holders, line, rejoined:rejoined ?? false});
  if (!lastWait || rejoined) { lastWait = state; console.log(state); }
} });
console.log(JSON.stringify({acquired:agent}));
if (Number(stallMs) > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs));
  console.log(JSON.stringify({resumed:true}));
}
process.stdin.setEncoding('utf8');
for await (const line of process.stdin) {
  if (line.trim() === 'renew') {
    try { lease.renew(); console.log(JSON.stringify({renewed:true})); }
    catch (error) { console.log(JSON.stringify({renewError:error.code})); }
  }
  if (line.trim() === 'release') { lease.release(); break; }
}
`;

/** Create isolated machine storage and a pair of real Git repositories. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-resources-'));
  TEMP.push(dir);
  const home = join(dir, 'home');
  const first = join(dir, 'repo-a');
  const second = join(dir, 'repo-b');
  for (const repo of [first, second]) {
    mkdirSync(repo);
    const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { dir, home, first, second, env: { ...process.env, PULLBOARD_HOME: home } };
}

/** Create the previous private queue schema so simultaneous openers exercise its migration. */
function oldSchema(box) {
  mkdirSync(box.home, { recursive: true });
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.exec(`CREATE TABLE resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE INDEX holder_name ON holder(name);
      CREATE TABLE waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE INDEX waiter_name_ticket ON waiter(name, ticket);`);
  } finally { db.close(); }
}

/** Force a stale private fixture row with a mismatched process start identity. */
function staleIdentity(box, table, agent) {
  assert.ok(['holder', 'waiter'].includes(table));
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const result = db.prepare(`UPDATE ${table} SET started = ?, heartbeat = 0 WHERE agent = ?`).run('old-process-start', agent);
    assert.equal(result.changes, 1, `${agent} has a private ${table} row`);
  } finally { db.close(); }
}

/** Expire a private lease heartbeat without changing its recorded OS identity. */
function expireHeartbeat(box, table, agent) {
  assert.ok(['holder', 'waiter'].includes(table));
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const result = db.prepare(`UPDATE ${table} SET heartbeat = 0 WHERE agent = ?`).run(agent);
    assert.equal(result.changes, 1, `${agent} has a private ${table} row`);
  } finally { db.close(); }
}

/** Read a private machine database without changing the process environment for other fixtures. */
function privateList(box, scope = 'machine', root = process.cwd()) {
  const previous = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.home;
  try { return listResources({ scope, root }); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previous;
  }
}

/** Launch one independent process that takes a resource and waits for a release command. */
function worker(box, { name = 'gate', capacity = 1, scope = 'machine', root = box.first, agent, stallMs = 0, env = {}, sandboxProcessInfo = false }) {
  const workerArgs = ['--input-type=module', '-e', WORKER, name, String(capacity), scope, root, agent, String(stallMs)];
  const executable = sandboxProcessInfo ? '/usr/bin/sandbox-exec' : process.execPath;
  const args = sandboxProcessInfo ? ['-p', PROCESS_INFO_POLICY, process.execPath, ...workerArgs] : workerArgs;
  const child = spawn(executable, args, {
    env: { ...box.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.lines = createInterface({ input: child.stdout });
  child.errors = '';
  child.pendingLines = [];
  child.lineWaiters = [];
  child.exitResult = null;
  child.finished = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    child.exitResult = { code, signal };
    CHILDREN.delete(child);
    for (const waiter of child.lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker exited ${code}/${signal}: ${child.errors}`));
    }
    resolveExit(child.exitResult);
  }));
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.errors += chunk; });
  child.lines.on('line', (line) => {
    const waiter = child.lineWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); }
    else child.pendingLines.push(line);
  });
  CHILDREN.add(child);
  return child;
}

/** Read the next worker event, failing promptly with its stderr if it exits unexpectedly. */
async function event(child, timeoutMs = 10_000) {
  if (child.pendingLines.length) return JSON.parse(child.pendingLines.shift());
  if (child.exitResult) throw new Error(`worker exited ${child.exitResult.code}/${child.exitResult.signal}: ${child.errors}`);
  const line = await new Promise((resolveLine, reject) => {
    const waiter = { resolve: resolveLine, reject, timer: setTimeout(() => {
      child.lineWaiters.splice(child.lineWaiters.indexOf(waiter), 1);
      reject(new Error(`worker timed out: ${child.errors}`));
    }, timeoutMs) };
    child.lineWaiters.push(waiter);
  });
  return JSON.parse(line);
}

/** Read worker events until its real process acquires a resource place. */
async function acquired(child) {
  while (true) {
    const state = await event(child);
    if (state.acquired) return state;
  }
}

/** Read the OS process state for an exact PID under stable locale settings. */
function processState(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
  });
  return result.status === 0 ? result.stdout.trim().split(/\s+/u)[0] ?? '' : '';
}

/** Wait until the OS reports a requested process state, or fail with the last state observed. */
async function waitForProcessState(pid, state, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = processState(pid);
  while (!actual.startsWith(state) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    actual = processState(pid);
  }
  assert.ok(actual.startsWith(state), `process ${pid} has state ${actual || '(unreadable)'}, expected ${state}`);
}

/** Sleep without blocking the test runner event loop. */
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/** Add an expired holder row to a private fixture database. */
function insertExpiredHolder(box, { name, pid, agent, started = '' }) {
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO resource(name, capacity) VALUES (?, 1)').run(name);
    db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`fixture-${agent}`, name, pid, started, agent, realpathSync(box.first), new Date(Date.now() - 60_000).toISOString(), Date.now() - 60_000);
  } finally { db.close(); }
}

/** Ask a holder to release and wait for clean process exit. */
async function release(child) {
  child.stdin.end('release\n');
  const { code } = await child.finished;
  child.lines.close();
  assert.equal(code, 0, child.errors);
}

/** Kill and reap every fixture worker before deleting its private files. */
after(async () => {
  const running = [...CHILDREN];
  for (const child of running) if (!child.exitResult) child.kill('SIGKILL');
  await Promise.all(running.map((child) => child.finished));
  for (const child of running) child.lines.close();
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test('[Q1,Q2] capacity-one takers acquire in strict FIFO arrival order', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiting = [];
  let firstQueuedAt = 0;
  for (const agent of ['first', 'second', 'third']) {
    const child = worker(box, { agent });
    waiting.push(child);
    const state = await event(child);
    assert.equal(state.waiting, waiting.length, `${agent} reports its FIFO place`);
    assert.equal(state.holders[0].agent, 'holder', `${agent} says who holds the place`);
    if (agent === 'first') {
      assert.equal(state.holders[0].repo, realpathSync(box.first), 'machine-scope listings still identify the Git root');
      firstQueuedAt = Date.parse(state.line[0].since);
      assert.ok(Number.isFinite(firstQueuedAt));
    }
  }
  const order = [];
  let current = holder;
  for (const [index, child] of waiting.entries()) {
    await release(current);
    assert.equal((await event(child)).acquired, ['first', 'second', 'third'][index]);
    if (index === 0) {
      const displayed = privateList(box).find((resource) => resource.name === 'gate').holders[0];
      assert.ok(Date.parse(displayed.since) > firstQueuedAt, 'holder since is when capacity was acquired, not when it joined the queue');
    }
    order.push(['first', 'second', 'third'][index]);
    current = child;
  }
  await release(current);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('[Q1,Q2] capacity two admits two holders and serves the next waiter', async () => {
  const box = fixture();
  const first = worker(box, { name: 'two-slots', capacity: 2, agent: 'first-holder' });
  const second = worker(box, { name: 'two-slots', capacity: 2, agent: 'second-holder' });
  assert.equal((await acquired(first)).acquired, 'first-holder');
  assert.equal((await acquired(second)).acquired, 'second-holder');
  const next = worker(box, { name: 'two-slots', capacity: 2, agent: 'next-waiter' });
  assert.equal((await event(next)).waiting, 1);
  await release(first);
  assert.equal((await event(next)).acquired, 'next-waiter');
  await release(second);
  await release(next);
});

test('[Q2,Q3] a stopped head waiter keeps its place ahead of the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const first = worker(box, { agent: 'stopped-first' });
  assert.equal((await event(first)).waiting, 1);
  first.kill('SIGSTOP');
  const second = worker(box, { agent: 'second' });
  assert.equal((await event(second)).waiting, 2);
  await release(holder);
  await assert.rejects(event(second, 800), /worker timed out/u, 'the second waiter cannot jump the stopped head');
  first.kill('SIGCONT');
  assert.equal((await event(first)).acquired, 'stopped-first');
  await release(first);
  assert.equal((await event(second)).acquired, 'second');
  await release(second);
});

test('[Q2,Q3] an evicted live waiter rejoins the FIFO line after it resumes [Q2,Q3]', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiter = worker(box, { agent: 'resumed-waiter' });
  assert.equal((await event(waiter)).waiting, 1);
  waiter.kill('SIGSTOP');
  staleIdentity(box, 'waiter', 'resumed-waiter');
  assert.deepEqual(privateList(box)[0].line, []);
  waiter.kill('SIGCONT');
  const rejoined = await event(waiter);
  assert.equal(rejoined.rejoined, true);
  assert.equal(rejoined.waiting, 1);
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'resumed-waiter');
  await release(waiter);
});

test('[Q3] a live stalled holder keeps its place beyond the lease timeout', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'stalled-holder', stallMs: 22_000, env: { TZ: 'UTC' } });
  assert.equal((await event(holder)).acquired, 'stalled-holder');
  const waiter = worker(box, { agent: 'queued-behind-live-holder', env: { TZ: 'Pacific/Honolulu', PATH: '/usr/bin' } });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'a live OS process must not be evicted when its heartbeat pauses');
  assert.equal((await event(holder, 5_000)).resumed, true);
  await release(holder);
  assert.equal((await event(waiter)).acquired, 'queued-behind-live-holder');
  await release(waiter);
});

test('[Q3] concurrent openers serialize migration of a prior resource database', async () => {
  const box = fixture();
  oldSchema(box);
  const workers = Array.from({ length: 8 }, (_, index) => worker(box, { name: 'legacy', capacity: 8, agent: `migrator-${index}` }));
  const grants = await Promise.all(workers.map((child) => acquired(child)));
  assert.deepEqual(grants.map(({ acquired: agent }) => agent).sort(), workers.map((_, index) => `migrator-${index}`).sort());
  await Promise.all(workers.map(release));
});

test('[Q3] a held lease records its OS process start identity', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'identity-recorded' });
  assert.equal((await acquired(holder)).acquired, 'identity-recorded');
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    const row = db.prepare('SELECT started FROM holder WHERE agent = ?').get('identity-recorded');
    assert.ok(row?.started, 'a readable process identity is stored with its lease');
  } finally { db.close(); }
  await release(holder);
});

test('[Q3] process identity lookup ignores a misleading ps on PATH', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'path-spoof-holder' });
  assert.equal((await acquired(holder)).acquired, 'path-spoof-holder');
  expireHeartbeat(box, 'holder', 'path-spoof-holder');
  const fakeBin = join(box.dir, 'fake-bin');
  mkdirSync(fakeBin);
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\nprintf "Mon Jan 1 00:00:00 2001 S\\n"\n');
  chmodSync(fakePs, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    assert.equal(privateList(box)[0].holders[0]?.agent, 'path-spoof-holder', 'the stable absolute ps result keeps the lease');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await release(holder);
});

test('[Q3] an unreadable process identity keeps a live holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-live-holder', stallMs: 27_000 });
  assert.equal((await acquired(holder)).acquired, 'sandbox-live-holder');
  const waiter = worker(box, { agent: 'sandbox-live-waiter', sandboxProcessInfo: true });
  assert.equal((await event(waiter)).waiting, 1);
  await assert.rejects(event(waiter, 20_500), /worker timed out/u, 'denied process-info access is not proof that a live PID died');
  assert.equal((await event(holder, 8_000)).resumed, true);
  await release(holder);
  assert.equal((await acquired(waiter)).acquired, 'sandbox-live-waiter');
  await release(waiter);
});

test('[Q3] an unreadable process identity still releases a dead holder', { skip: !SANDBOX_EXEC }, async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'sandbox-dead-holder' });
  assert.equal((await acquired(holder)).acquired, 'sandbox-dead-holder');
  holder.kill('SIGKILL');
  const { signal } = await holder.finished;
  holder.lines.close();
  assert.equal(signal, 'SIGKILL');
  const waiter = worker(box, { agent: 'sandbox-dead-waiter', sandboxProcessInfo: true });
  assert.equal((await acquired(waiter)).acquired, 'sandbox-dead-waiter');
  await release(waiter);
});

test('[Q3] cached live identities expire so an actual zombie holder is released', { skip: !PERL_FORK }, async () => {
  const box = fixture();
  privateList(box);
  const script = 'my $pid = fork(); die "fork failed" unless defined $pid; if ($pid == 0) { select undef, undef, undef, 1.2; exit 0; } print "$pid\\n"; $| = 1; select undef, undef, undef, 30; waitpid($pid, 0);';
  const reaper = spawn('/usr/bin/perl', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: reaper.stdout });
  try {
    const pidText = await new Promise((resolveLine, reject) => {
      lines.once('line', resolveLine);
      reaper.once('error', reject);
      reaper.once('exit', (code) => reject(new Error(`zombie parent exited early: ${code}`)));
    });
    const pid = Number(pidText);
    assert.ok(Number.isInteger(pid) && pid > 0, `Perl reports its child PID: ${pidText}`);
    insertExpiredHolder(box, { name: 'zombie-cache', pid, agent: 'zombie-holder' });
    const cached = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.equal(cached.holders[0]?.agent, 'zombie-holder', 'the live child with an empty stored identity is kept');
    const cacheAt = Date.now();
    await waitForProcessState(pid, 'Z');
    await delay(Math.max(0, cacheAt + 3_200 - Date.now()));
    const afterExpiry = privateList(box).find(({ name }) => name === 'zombie-cache');
    assert.deepEqual(afterExpiry.holders, [], 'the refreshed process state identifies and releases the zombie');
  } finally {
    lines.close();
    if (reaper.exitCode === null && reaper.signalCode === null) {
      reaper.kill('SIGKILL');
      await once(reaper, 'exit');
    }
  }
});

test('[Q3] renew refuses after an OS start-identity mismatch evicts the holder', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'evicted-holder' });
  assert.equal((await event(holder)).acquired, 'evicted-holder');
  staleIdentity(box, 'holder', 'evicted-holder');
  assert.deepEqual(privateList(box)[0].holders, []);
  holder.stdin.write('renew\n');
  assert.equal((await event(holder)).renewError, 'RESOURCE_LEASE_LOST');
  holder.stdin.end('release\n');
  assert.equal((await holder.finished).code, 0, holder.errors);
});

test('[Q3] SIGKILL of a holder frees its lease for the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'doomed-holder' });
  assert.equal((await event(holder)).acquired, 'doomed-holder');
  const next = worker(box, { agent: 'successor' });
  const waiting = await event(next);
  assert.equal(waiting.waiting, 1);
  holder.kill('SIGKILL');
  await holder.finished;
  assert.equal((await event(next)).acquired, 'successor');
  await release(next);
});

test('[Q2,Q3] a SIGKILLed waiter is skipped while the next live waiter advances', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const dead = worker(box, { agent: 'dead-waiter' });
  assert.equal((await event(dead)).waiting, 1);
  const live = worker(box, { agent: 'live-waiter' });
  assert.equal((await event(live)).waiting, 2);
  dead.kill('SIGKILL');
  await dead.finished;
  await release(holder);
  assert.equal((await event(live)).acquired, 'live-waiter');
  await release(live);
});

test('[Q4] machine capacity changes atomically refuse an occupied or queued resource', async () => {
  const box = fixture();
  const oldHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.home;
  const holder = worker(box, { agent: 'capacity-holder' });
  try {
    assert.equal((await event(holder)).acquired, 'capacity-holder');
    const waiter = worker(box, { agent: 'capacity-waiter' });
    assert.equal((await event(waiter)).waiting, 1);
    let persisted = false;
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    assert.equal(persisted, false, 'settings remain unchanged while a holder and waiter exist');
    await release(holder);
    assert.equal((await event(waiter)).acquired, 'capacity-waiter');
    assert.throws(() => setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } }), (error) => error.code === 'RESOURCE_BUSY');
    await release(waiter);
    const changed = setResourceCapacity({ name: 'gate', capacity: 3, persist: () => { persisted = true; } });
    assert.deepEqual(changed, { name: 'gate', capacity: 3 });
    assert.equal(persisted, true, 'settings persist under the same queue lock as the capacity');
    assert.equal(privateList(box)[0].capacity, 3);
    const lease = await takeResource({ name: 'gate', capacity: 3, capacityProvider: () => 4, allowIdleCapacityUpdate: true, root: box.first, agent: 'fresh-capacity' });
    assert.equal(privateList(box)[0].capacity, 4, 'a queued gate reads the latest setting after taking the SQLite lock');
    lease.release();
  } finally {
    if (!holder.exitResult) await release(holder);
    if (oldHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = oldHome;
  }
});

test('[Q1] machine scope is shared, repo scope stays local, and board scope names relay requirement', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'repo-a', root: box.first });
  assert.equal((await event(holder)).acquired, 'repo-a');
  const otherRepo = worker(box, { agent: 'repo-b', root: box.second });
  assert.equal((await event(otherRepo)).waiting, 1);
  await release(holder);
  assert.equal((await event(otherRepo)).acquired, 'repo-b');
  await release(otherRepo);
  const localA = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-a', root: box.first });
  const localB = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-b', root: box.second });
  assert.equal((await event(localA)).acquired, 'repo-a');
  assert.equal((await event(localB)).acquired, 'repo-b');
  await release(localA);
  await release(localB);
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(MODULE)}; await takeResource({name:'x',capacity:1,scope:'board'});`], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BOARD_SCOPE_UNAVAILABLE.*relay/i);
});

test('[Q4] a red gate releases its lease before the same process starts another gate', async () => {
  const box = fixture();
  const setting = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), 'settings', 'gateSlots', '1'], {
    cwd: box.first, env: box.env, encoding: 'utf8',
  });
  assert.equal(setting.status, 0, setting.stderr);
  const command = join(box.dir, 'red-then-green.cjs');
  const counter = join(box.dir, 'gate-count');
  const eventsFile = join(box.dir, 'gate-runs.log');
  writeFileSync(command, [
    "const fs = require('node:fs');",
    'const [counter, events] = process.argv.slice(2);',
    'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0);',
    'fs.writeFileSync(counter, String(count + 1));',
    "fs.appendFileSync(events, 'start\\nend\\n');",
    'process.exit(count === 0 ? 7 : 0);',
  ].join('\n'));
  const gateCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(command)} ${JSON.stringify(counter)} ${JSON.stringify(eventsFile)}`;
  const worker = `
    import { runGate } from ${JSON.stringify(GATE_MODULE)};
    const first = await runGate(process.cwd(), { gate: process.argv[1] });
    const second = await runGate(process.cwd(), { gate: process.argv[1] });
    console.log(JSON.stringify({ firstGreen: first.isGreen, secondGreen: second.isGreen }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, gateCommand], {
    cwd: box.first, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the red gate kept its lease and blocked the same process')), 5_000); }),
    ]);
    assert.equal(result.code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { firstGreen: false, secondGreen: true });
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/u), ['start', 'end', 'start', 'end']);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await closed;
  }
});
