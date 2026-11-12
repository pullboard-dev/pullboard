/**
 * One machine-wide pool of test-file tokens [C7]: every test-file process takes a token before its tests run,
 * so the files running at once on a machine never exceed its cores, however many runs share it.
 *
 * Measured 22 Oct: 28 runs at --test-concurrency=10 kept 54 file processes live on 14 cores, and passing files
 * ran 18.5 times slower in landings than alone. A per-run limit cannot see the other runs; this pool can.
 *
 * A test file that starts a nested run with a synchronous call is blocked until that call returns, so it lends its
 * place for the call: the call's files fill that place one at a time and never take a second core, and the call
 * returns only after the last of them exits, so the file resumes into its own place. Nothing it starts can wait
 * forever on the token it holds. An asynchronous run borrows nothing until its parent explicitly promises to yield through awaitNestedRun.
 * A run left behind by a completed call borrows nothing.
 */
import { randomUUID } from 'node:crypto';
import { errorMonitor } from 'node:events';
import { mkdirSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { machineHome } from '../../../../../resources/index.js';
import { Refused } from '../../../../../kernel/index.js';

const asyncOffers = new WeakMap();
const independentChildren = new WeakMap();
let activeAsyncWait = null;
let ownsFileToken = false;

/** Names the pool a test-file process takes from, and the file process that started this run, as JSON. */
export const TEST_FILE_POOL_ENV = 'PULLBOARD_TEST_FILE_POOL';
/** Overrides the pool size; a test models a smaller machine with it. */
export const TEST_FILE_CORES_ENV = 'PULLBOARD_TEST_FILE_CORES';
// Budget: a waiting file looks again this often with one read; it takes the write lock only when a place looks
// free, or once a second to prune rows of processes that have gone.
const POLL_MS = 25;
const PRUNE_MS = 1_000;
// Budget: a new pool's one-time setup waits out other files setting it up this long before it fails.
const SETUP_LOCK_MS = 10_000;

/**
 * Read the pool a test-file process belongs to, or null outside a run-tests run.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ home: string, cores: number, lender?: number } | null}
 */
export function testFilePool(env = process.env) {
  const value = env[TEST_FILE_POOL_ENV];
  if (!value) return null;
  try {
    const pool = JSON.parse(value);
    if (typeof pool?.home !== 'string' || !Number.isSafeInteger(pool.cores) || pool.cores < 1) return null;
    if (pool.lender !== undefined && !Number.isSafeInteger(pool.lender)) return null;
    if (pool.call !== undefined && typeof pool.call !== 'string') return null;
    return pool;
  } catch { return null; }
}

/**
 * The pool value a run passes to its test files: an inherited one, so a nested run shares its parent's pool and
 * lender, or this machine's pool sized to its cores.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function testFilePoolValue(env = process.env) {
  const pool = testFilePool(env);
  // A nested run's files keep the file that started it as their lender, so they take its place.
  if (pool) return JSON.stringify({ home: pool.home, cores: pool.cores, ...(pool.lender ? { lender: pool.lender, call: pool.call } : {}) });
  const override = Number(env[TEST_FILE_CORES_ENV]);
  const cores = Number.isSafeInteger(override) && override > 0 ? override : Math.max(1, availableParallelism());
  return JSON.stringify({ home: machineHome(), cores });
}

/**
 * Load SQLite without its experimental warning: the runner's own output must stay exactly what its tests pin,
 * and a run that never nests never loads it at all.
 */
async function databaseSync() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
  };
  try { return (await import('node:sqlite')).DatabaseSync; }
  finally { process.emitWarning = emitWarning; }
}

/** Open the pool's database, creating its tables on first use. */
async function openPool(home) {
  mkdirSync(home, { recursive: true });
  const DatabaseSync = await databaseSync();
  const db = new DatabaseSync(join(home, 'test-file-pool.sqlite'));
  db.exec('PRAGMA busy_timeout = 10000');
  // Switching a new pool to WAL takes an exclusive lock that SQLite may refuse at once, without the busy wait,
  // when many files open the same new pool together; wait the lock out like any other.
  for (let deadline = Date.now() + SETUP_LOCK_MS; ; await new Promise(next => setTimeout(next, POLL_MS))) {
    try { db.exec('PRAGMA journal_mode = WAL'); break; }
    catch (error) { if (!/locked|busy/iu.test(error.message) || Date.now() > deadline) throw error; }
  }
  db.exec(`
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS file_holder(pid INTEGER PRIMARY KEY, since INTEGER NOT NULL, lender INTEGER);
    CREATE TABLE IF NOT EXISTS file_waiter(ticket INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS file_call(call TEXT PRIMARY KEY, lender INTEGER NOT NULL, closing INTEGER NOT NULL DEFAULT 0);`);
  // A pool made by an earlier build of this module gains the columns it lacks; a missing value reads as none.
  // Another file may add the same column first; its addition is as good as ours.
  const addColumn = (table, column, type) => {
    if (db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry.name === column)) return;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
    catch (error) { if (!/duplicate column/iu.test(error.message)) throw error; }
  };
  addColumn('file_holder', 'lender', 'INTEGER');
  addColumn('file_holder', 'call', 'TEXT');
  addColumn('file_call', 'closing', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('file_call', 'path', 'TEXT');
  addColumn('file_holder', 'path', 'TEXT');
  addColumn('file_holder', 'dispatch', 'TEXT');
  return db;
}

/** Whether a process is alive; a process another user owns still is. */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Run one write transaction that no other process interleaves. */
function immediate(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Drop rows whose process has gone, so a crashed file or call never holds a place. */
function prune(db) {
  for (const { pid } of db.prepare('SELECT pid FROM file_holder').all()) {
    if (!alive(pid)) db.prepare('DELETE FROM file_holder WHERE pid = ?').run(pid);
  }
  for (const { pid } of db.prepare('SELECT pid FROM file_waiter').all()) {
    if (!alive(pid)) db.prepare('DELETE FROM file_waiter WHERE pid = ?').run(pid);
  }
  for (const { lender } of db.prepare('SELECT DISTINCT lender FROM file_call').all()) {
    if (!alive(lender)) db.prepare('DELETE FROM file_call WHERE lender = ?').run(lender);
  }
}

/**
 * The places taken. A holder inside a synchronous call is blocked, so it takes no place of its own: it reserves one
 * place, which one file of that call fills. Every other holder takes one place. The reserved place comes back to the
 * caller when its file exits, and the call returns only after that (see lendThroughSyncCalls), so no other file can
 * take it in between and the caller resumes into its own place.
 */
function occupied(db) {
  return db.prepare(`WITH calling AS (SELECT DISTINCT lender AS pid FROM file_call WHERE lender IN (SELECT pid FROM file_holder))
    SELECT (SELECT count(*) FROM file_holder WHERE pid NOT IN (SELECT pid FROM calling))
      + (SELECT count(*) FROM calling WHERE NOT EXISTS (SELECT 1 FROM file_holder
          WHERE file_holder.call IN (SELECT call FROM file_call WHERE file_call.lender = calling.pid))) AS n`).get().n;
}

/** How many places are taken and how many waiters are ahead of this one, read without a write lock. */
function standing(db) {
  const mine = db.prepare('SELECT ticket FROM file_waiter WHERE pid = ?').get(process.pid)?.ticket;
  const ahead = db.prepare('SELECT count(*) AS n FROM file_waiter WHERE ticket < ?').get(mine).n;
  return { taken: occupied(db), ahead };
}

/**
 * The places taken in a pool, for a test that builds its rows by hand.
 *
 * @param {string} home
 * @returns {Promise<number>}
 */
export async function occupiedPlaces(home) {
  const db = await openPool(home);
  try { prune(db); return occupied(db); } finally { db.close(); }
}

/**
 * Admit this process when a place is free and every earlier waiter fits first. A file started inside its caller's
 * open synchronous call steps into the caller's reserved place when no other file of the caller holds it; that
 * leaves the count unchanged. Only a file admitted that way belongs to the call, and it takes the call's path.
 *
 * @returns {false | string} false while it must wait; once admitted, its call path ('' outside any call).
 */
function admit(db, cores, lender, call) {
  return immediate(db, () => {
    prune(db);
    const reserved = call && db.prepare(`SELECT 1 FROM file_call WHERE call = ? AND closing = 0 AND lender IN (SELECT pid FROM file_holder)
      AND NOT EXISTS (SELECT 1 FROM file_holder WHERE file_holder.call IN (SELECT call FROM file_call WHERE lender = ?))`).get(call, lender);
    if (!reserved) {
      const { taken, ahead } = standing(db);
      if (ahead >= cores - taken) return false;
    }
    db.prepare('DELETE FROM file_waiter WHERE pid = ?').run(process.pid);
    // A file of a call inherits the call's path, so the call's whole descent stays findable if a file in between dies.
    const path = reserved ? db.prepare('SELECT path FROM file_call WHERE call = ?').get(call)?.path ?? `/${call}` : null;
    db.prepare('INSERT OR REPLACE INTO file_holder(pid, since, lender, call, path) VALUES (?, ?, ?, ?, ?)')
      .run(process.pid, Date.now(), lender ?? null, reserved ? call : null, path);
    return path ?? '';
  });
}

/**
 * Take this test-file process's token and hold it until the process exits; then lend its place through its
 * synchronous child calls.
 *
 * @param {NodeJS.ProcessEnv} env - Changed in place: descendants see this file's pool, without a lender.
 * @returns {Promise<number>} How long this file waited for its token, in ms.
 */
export async function takeTestFileToken(env = process.env) {
  const pool = testFilePool(env);
  if (!pool) return 0;
  const asked = Date.now();
  const db = await openPool(pool.home);
  const dispatched = pool.dispatch;
  if (dispatched) {
    if (!Number.isSafeInteger(dispatched.parent) || dispatched.parent !== process.ppid
      || typeof dispatched.nonce !== 'string' || !dispatched.nonce) {
      db.close();
      throw new Error('test-file admission does not name this worker parent');
    }
    const adopted = immediate(db, () => db.prepare('UPDATE file_holder SET pid = ? WHERE pid = ? AND dispatch = ?')
      .run(process.pid, dispatched.parent, dispatched.nonce).changes);
    if (adopted !== 1) {
      db.close();
      throw new Error('test-file admission was lost before worker startup');
    }
  } else immediate(db, () => db.prepare('INSERT OR IGNORE INTO file_waiter(pid) VALUES (?)').run(process.pid));
  let pruned = 0;
  let reported = false;
  let path;
  while (!dispatched) {
    const { taken, ahead } = standing(db);
    // A dead holder only goes in the write path, so look there at least once a second even when nothing looks free.
    if (pool.call || ahead < pool.cores - taken || Date.now() - pruned >= PRUNE_MS) {
      pruned = Date.now();
      path = admit(db, pool.cores, pool.lender, pool.call);
      if (path !== false) break;
    }
    if (!reported && pool.call?.startsWith('async:') && pool.lender &&
      db.prepare('SELECT 1 FROM file_holder h WHERE h.pid = ? AND NOT EXISTS (SELECT 1 FROM file_call WHERE lender = h.pid)').get(pool.lender)) {
      process.stderr.write(`test-file-pool: parent ${pool.lender} is holding its token while nested files wait; use awaitNestedRun(child) only while yielding.\n`);
      reported = true;
    }
    await new Promise(done => setTimeout(done, POLL_MS));
  }
  if (dispatched) path = db.prepare('SELECT path FROM file_holder WHERE pid = ?').get(process.pid)?.path ?? '';
  process.once('exit', () => {
    try {
      // The dispatcher's row stays charged through every exit listener until the actual process has exited.
      if (!dispatched) db.prepare('DELETE FROM file_holder WHERE pid = ?').run(process.pid);
      db.close();
    }
    catch { /* A row left behind is pruned once this process is gone. */ }
  });
  env[TEST_FILE_POOL_ENV] = JSON.stringify({ home: pool.home, cores: pool.cores });
  ownsFileToken = true;
  lendThroughAsyncSpawn(pool, env, db, path);
  lendThroughSyncCalls(pool, env, db, path);
  return Date.now() - asked;
}

/**
 * Reserve one FIFO place before the dispatcher starts a file. A dispatcher has only one pending reservation;
 * its actual file worker atomically adopts that existing row, preserving the lender/call/path and charge.
 * This uses the same holder/waiter tables, not a second capacity pool or run registry.
 */
export async function reserveTestFileToken(env, signal) {
  if (ownsFileToken) throw new Error('a test file must start a separate runner before dispatching nested files');
  const pool = JSON.parse(testFilePoolValue(env));
  const db = await openPool(pool.home);
  const nonce = randomUUID();
  let reserved = false;
  try {
    signal?.throwIfAborted();
    immediate(db, () => db.prepare('INSERT INTO file_waiter(pid) VALUES (?)').run(process.pid));
    let reported = false;
    while (!reserved) {
      signal?.throwIfAborted();
      reserved = admit(db, pool.cores, pool.lender, pool.call) !== false;
      if (!reserved && !reported && pool.call?.startsWith('async:') && pool.lender &&
        db.prepare('SELECT 1 FROM file_holder h WHERE h.pid = ? AND NOT EXISTS (SELECT 1 FROM file_call WHERE lender = h.pid)').get(pool.lender)) {
        process.stderr.write(`test-file-pool: parent ${pool.lender} is holding its token while nested files wait; use awaitNestedRun(child) only while yielding.\n`);
        reported = true;
      }
      if (!reserved) await new Promise(done => setTimeout(done, POLL_MS));
    }
    db.prepare('UPDATE file_holder SET dispatch = ? WHERE pid = ?').run(nonce, process.pid);
    const owned = () => db.prepare('SELECT pid FROM file_holder WHERE dispatch = ?').get(nonce);
    let closed = false;
    return {
      value: JSON.stringify({ ...pool, dispatch: { parent: process.pid, nonce } }),
      /** Do not acquire another place under this PID until the actual worker has adopted the first. */
      async transferred() {
        while (!closed && owned()?.pid === process.pid) {
          signal?.throwIfAborted();
          await new Promise(done => setTimeout(done, POLL_MS));
        }
      },
      /** A stream error does not authorize returning a token that its worker still owns. */
      async drained() {
        while (!closed) {
          const holder = owned();
          if (!holder || holder.pid === process.pid || !alive(holder.pid)) return;
          await new Promise(done => setTimeout(done, POLL_MS));
        }
      },
      /** Release only after the actual worker exits, or before any file was started. */
      release() {
        if (closed) return;
        const holder = owned();
        if (holder && holder.pid !== process.pid && alive(holder.pid)) {
          throw new Error('cannot release a test-file token while its actual worker is alive');
        }
        db.prepare('DELETE FROM file_holder WHERE dispatch = ?').run(nonce);
        db.close();
        closed = true;
      },
    };
  } catch (error) {
    immediate(db, () => {
      db.prepare('DELETE FROM file_waiter WHERE pid = ?').run(process.pid);
      if (reserved) db.prepare('DELETE FROM file_holder WHERE pid = ?').run(process.pid);
    });
    db.close();
    throw error;
  }
}

/** Block this thread for a moment without spinning: the caller is inside a synchronous call anyway. */
function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lend this file's place only across a synchronous child call (spawnSync, execFileSync, execSync), which blocks this
 * file's JavaScript until the call returns. The call is a row: while it is open, one file it starts may fill the
 * place. When the child returns, the call closes to new files, and it returns to this file only once the file that
 * filled the place, and every file under it, has exited, so this file never resumes beside them, even when a file in
 * between died. A run the call leaves behind lends nothing.
 * A child started asynchronously gets no call: this file may keep computing, so it keeps its own token and the nested
 * files take theirs from the pool (#1046). A call whose environment no longer names this pool, as a test that
 * isolates its own pool does, is left exactly as written.
 */
function lendThroughSyncCalls(pool, env, db, path) {
  const ours = env[TEST_FILE_POOL_ENV];
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = childProcess[name];
    childProcess[name] = function lendingSyncCall(...args) {
      const at = args.findIndex((arg, index) => index > 0 && arg && typeof arg === 'object' && !Array.isArray(arg));
      const options = at === -1 ? {} : args[at];
      const childEnv = options.env ?? env;
      if (childEnv[TEST_FILE_POOL_ENV] !== ours) return original.apply(this, args);
      const call = randomUUID();
      const lent = JSON.stringify({ home: pool.home, cores: pool.cores, lender: process.pid, call });
      const lending = { ...options, env: { ...childEnv, [TEST_FILE_POOL_ENV]: lent } };
      if (at === -1) args.push(lending); else args[at] = lending;
      const callPath = `${path}/${call}`;
      db.prepare('INSERT INTO file_call(call, lender, path) VALUES (?, ?, ?)').run(call, process.pid, callPath);
      try { return original.apply(this, args); }
      finally {
        db.prepare('UPDATE file_call SET closing = 1 WHERE call = ?').run(call);
        // Every file under this call, not only its own: one whose middle file died is still this call's work.
        const descent = db.prepare("SELECT pid FROM file_holder WHERE path = ? OR substr(path, 1, ?) = ?");
        while (descent.all(callPath, callPath.length + 1, `${callPath}/`).some(({ pid }) => alive(pid))) pauseSync(POLL_MS);
        db.prepare('DELETE FROM file_call WHERE call = ?').run(call);
      }
    };
  }
  syncBuiltinESMExports();
}

/** Close a loan before draining its borrowed descent, so no new file can race the last sample. */
async function closeAsyncCall(db, call, callPath, closed) {
  db.prepare('UPDATE file_call SET closing = 1 WHERE call = ?').run(call);
  await closed;
  const descent = db.prepare("SELECT pid FROM file_holder WHERE path = ? OR substr(path, 1, ?) = ?");
  while (descent.all(callPath, callPath.length + 1, `${callPath}/`).some(({ pid }) => alive(pid))) {
    await new Promise(next => setTimeout(next, POLL_MS));
  }
  db.prepare('DELETE FROM file_call WHERE call = ?').run(call);
}

/** Observe close from spawn onward without consuming an otherwise unhandled child error. */
function observeAsyncChild(child) {
  const outcome = { error: null, status: null, signal: null };
  child.once(errorMonitor, error => { outcome.error = error; });
  const closed = new Promise(resolve => child.once('close', (status, signal) => {
    outcome.status = status;
    outcome.signal = signal;
    resolve(outcome);
  }));
  return { outcome, closed };
}

/** Await a raw child through close, preserving a spawn error instead of inventing an exit status. */
async function rawChildResult(observed, child) {
  const onError = () => {};
  child.once('error', onError);
  try {
    const result = await observed.closed;
    if (result.error) throw result.error;
    return { status: result.status, signal: result.signal };
  } finally { child.removeListener('error', onError); }
}

/**
 * Explicitly await a nested child while promising that this test file yields its token until the wait returns.
 * Pass a ChildProcess or the original fixture promise carrying `.child`; fixture results/errors are unchanged.
 * This is a caller contract, not proof that arbitrary callbacks stop computing: do no unrelated work and never
 * abandon the returned wait through Promise.race. Signal the child inside the wait, then let this helper drain.
 * Only one explicit wait may be active in a file. Plain spawned children borrow nothing, and isolated child pools
 * retain ordinary waits. Standalone fixture promises also retain normal waits; an unobserved raw child outside
 * an admitted file is refused because past error/close events cannot be reconstructed. Closing admission before finally draining borrowed descendants prevents an early return.
 * If cleanup cannot prove the token is safe to resume, this test process exits rather than returning a live loan.
 */
export async function awaitNestedRun(handle) {
  return await nestedRunWait(handle, null);
}

/** Lend while coordinating only this child's marker and barrier, then await its complete drain. */
export async function awaitNestedPhase(handle, coordinate) {
  if (typeof coordinate !== 'function') throw new TypeError('an interactive nested wait needs its coordination function');
  return await nestedRunWait(handle, coordinate);
}

/** Coordinate only this group of nested children while lending the caller's one shared place. */
export async function withNestedGroup(coordinate) {
  if (typeof coordinate !== 'function') throw new TypeError('a nested group needs its coordination function');
  if (activeAsyncWait) throw new Refused('NESTED_RUN_WAIT_ACTIVE', 'Finish the active nested wait before opening a group.');
  const records = [];
  let accepting = true;
  activeAsyncWait = 'group';
  /** Admit a newly spawned exact child to this group before waiting for any of its markers. */
  function add(handle) {
    if (!accepting) throw new Refused('NESTED_RUN_WAIT_REUSED', 'The nested group is already closing.');
    const child = handle?.child ?? handle;
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      throw new Refused('NESTED_RUN_HANDLE_REQUIRED', 'Pass each original child or fixture promise to the nested group.');
    }
    const offer = asyncOffers.get(child);
    let observed = offer ?? independentChildren.get(child);
    if (!observed && !ownsFileToken && child.exitCode === null && child.signalCode === null) observed = observeAsyncChild(child);
    if (!observed) throw new Refused('NESTED_RUN_OFFER_REQUIRED', 'Start each child through the current spawn export before adding it.');
    if (offer?.used || records.some(record => record.child === child)) throw new Refused('NESTED_RUN_WAIT_REUSED', 'A child can belong to only one nested wait.');
    const onError = () => {};
    child.once('error', onError);
    if (offer) {
      try { immediate(offer.db, () => offer.db.prepare('INSERT INTO file_call(call, lender, path) VALUES (?, ?, ?)').run(offer.call, process.pid, offer.path)); }
      catch (error) { child.removeListener('error', onError); throw error; }
      offer.used = true;
    }
    if (typeof handle?.then === 'function') Promise.resolve(handle).catch(() => {});
    records.push({ child, offer, observed, onError });
    return handle;
  }
  let value, failure;
  try { value = await coordinate(add); }
  catch (error) {
    failure = error;
    for (const { child } of records) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  } finally {
    accepting = false;
    try {
      for (const { offer } of records) if (offer) offer.db.prepare('UPDATE file_call SET closing = 1 WHERE call = ?').run(offer.call);
      await Promise.all(records.map(({ observed }) => observed.closed));
      for (const { offer } of records) if (offer) await closeAsyncCall(offer.db, offer.call, offer.path, offer.closed);
    } catch (error) {
      process.stderr.write(`test-file-pool: cannot close the nested group safely (${error.code ?? 'UNKNOWN'}); exiting this test process.\n`);
      process.exit(1);
    } finally {
      for (const { child, onError } of records) child.removeListener('error', onError);
      activeAsyncWait = null;
    }
  }
  if (failure) throw failure;
  return value;
}

/** Keep an early child failure observed while the declared coordination phase is pending. */
async function coordinatedResult(handle, child, observed, coordinate) {
  if (!coordinate) return typeof handle?.then === 'function' ? await handle : await rawChildResult(observed, child);
  const completion = (typeof handle?.then === 'function' ? Promise.resolve(handle) : rawChildResult(observed, child))
    .then(value => ({ value }), error => ({ error }));
  try { await coordinate(); }
  catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (child) await completion;
    throw error;
  }
  const result = await completion;
  if (Object.hasOwn(result, 'error')) throw result.error;
  return result.value;
}

/** Share the terminal loan's admission, error and drain rules with the interactive phase. */
async function nestedRunWait(handle, coordinate) {
  const child = handle?.child ?? handle;
  const isChild = child && typeof child.once === 'function' && typeof child.kill === 'function';
  if (!isChild && ownsFileToken) throw new Refused('NESTED_RUN_HANDLE_REQUIRED', 'Pass the original child or fixture promise with .child to awaitNestedRun.');
  if (!ownsFileToken && typeof handle?.then === 'function') return await coordinatedResult(handle, isChild ? child : null, null, coordinate);
  const offer = isChild ? asyncOffers.get(child) : null;
  if (!offer && isChild && !independentChildren.has(child)) throw new Refused('NESTED_RUN_OFFER_REQUIRED', 'Start this child with the current spawn export after token admission, then pass its original handle.');
  if (!offer) {
    if (isChild && typeof handle?.then !== 'function') {
      const observed = independentChildren.get(child);
      return coordinatedResult(handle, child, observed, coordinate);
    }
    return await coordinatedResult(handle, null, null, coordinate);
  }
  if (offer.used) throw new Refused('NESTED_RUN_WAIT_REUSED', 'This child was already awaited through its loan. Await the original returned wait instead.');
  if (activeAsyncWait) throw new Refused('NESTED_RUN_WAIT_ACTIVE', 'This file already lends its token. Finish that wait before lending to another child.');
  offer.used = true;
  activeAsyncWait = offer.call;
  const { db, call, path } = offer;
  let opened = false;
  // The explicit wait owns spawn-error handling; the dormant observer alone never swallows it.
  const onError = () => {};
  child.once('error', onError);
  try {
    immediate(db, () => db.prepare('INSERT INTO file_call(call, lender, path) VALUES (?, ?, ?)').run(call, process.pid, path));
    opened = true;
    return await coordinatedResult(handle, child, offer, coordinate);
  } finally {
    try { if (opened) await closeAsyncCall(db, call, path, offer.closed); }
    catch (error) {
      process.stderr.write(`test-file-pool: cannot close the nested loan safely (${error.code ?? 'UNKNOWN'}); exiting this test process.\n`);
      process.exit(1);
    }
    finally { child.removeListener('error', onError); activeAsyncWait = null; }
  }
}

/**
 * Give an async child an exact dormant offer before its environment is copied. An offer creates no loan row:
 * until awaitNestedRun explicitly activates it, admission counts the parent and child independently. A child
 * already admitted before activation keeps its own token; only later exact-call admissions borrow the place.
 * Preserve prior spawn guards, options and events; a fixture that chooses another pool gets no offer.
 */
function lendThroughAsyncSpawn(pool, env, db, path) {
  const ours = env[TEST_FILE_POOL_ENV];
  const original = childProcess.spawn;
  childProcess.spawn = function offeredAsyncSpawn(...args) {
    const second = args[1];
    // Leave invalid signatures to Node, and retain a third options object when args is null or omitted.
    if (second != null && !Array.isArray(second) && typeof second !== 'object') return original.apply(this, args);
    const optionsAt = second == null || Array.isArray(second) ? 2 : 1;
    const options = args[optionsAt];
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) return original.apply(this, args);
    // Match Node's own option projection and its enumerable environment, including prototype values.
    const normalized = { __proto__: null, ...options };
    const childEnv = normalized.env || process.env;
    const projected = Object.create(null);
    for (const name in childEnv) projected[name] = childEnv[name];
    args[optionsAt] = { __proto__: null, ...normalized, env: projected };
    if (projected[TEST_FILE_POOL_ENV] !== ours) {
      const independent = original.apply(this, args);
      independentChildren.set(independent, observeAsyncChild(independent));
      return independent;
    }
    const call = `async:${randomUUID()}`;
    const lent = JSON.stringify({ home: pool.home, cores: pool.cores, lender: process.pid, call });
    projected[TEST_FILE_POOL_ENV] = lent;
    const child = original.apply(this, args);
    asyncOffers.set(child, { db, call, path: `${path}/${call}`, used: false, ...observeAsyncChild(child) });
    return child;
  };
  syncBuiltinESMExports();
}

/**
 * Order test files longest-first by their last recorded wall time, so the slowest file never starts last.
 * A file with no record keeps its place after the timed ones; ties keep the given order.
 *
 * @param {string[]} files - As given to the runner, relative to `cwd` or absolute.
 * @param {Record<string, number>} times - Wall time in ms by repository-relative path.
 * @param {(file: string) => string} key - Maps a given file to its repository-relative path.
 * @returns {string[]}
 */
export function longestFirst(files, times, key) {
  const ms = file => times[key(file)];
  return files.map((file, index) => ({ file, index, time: ms(file) }))
    .sort((a, b) => (Number.isFinite(b.time) ? b.time : -1) - (Number.isFinite(a.time) ? a.time : -1) || a.index - b.index)
    .map(entry => entry.file);
}
