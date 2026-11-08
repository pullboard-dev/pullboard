import { repoRoot } from './seat-test-admission.js';
import { holdingTestSeats } from './seat-test-admission.js';
import { isSeatTest } from './seat-test-admission.js';
import { overdueSeatTestsFirst } from './seat-test-admission.js';
import { seatTestRepo } from './seat-test-admission.js';
import { beginResourceWrite } from './resource-write-lock.js';
import { resourceWriteError } from './resource-write-lock.js';
import { enqueueResourceWrite } from './resource-write-queue.js';
import { enterResourceQueue } from './resource-write-queue.js';
import { beatingProbes } from './waiter-heartbeat.js';
import { retainConnection } from './resource-connections.js';
import { renewWithBeat } from './renewal-beat.js';
import { createControllerCustody } from './controller-custody.js';
import { controllerLeaseHealth } from './controller-custody.js';
import { pruneControllerOrphans } from './controller-custody.js';
import { controllerRegistrationPorts } from './controller-custody.js';
import { consumeControllerDisposition } from './controller-disposition.js';
import { settleControllerCancellation } from './controller-disposition.js';
/** Machine and repository queues persist leases; landings first, then arrival order, or by class (landing, review, submit, other) aging up over time where the machine opts in [Q1,Q2,Q3]. */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { repoInfo } from '../../../../src/git.js';
import {
  machineHome,
  machineSettingsFile,
  withMachineHomeWrite,
} from './machine-home.js';
import { Refused } from '../../../kernel/index.js';
import { capturedRequestOf } from './holder-liveness.js';
import { dispatchRelaunch } from './holder-liveness.js';
import { LIVENESS_RELAUNCH_ENV } from './holder-liveness.js';
import { reclaimHolders } from './holder-liveness.js';
import { pinLegacyReclaimInputs } from './holder-liveness.js';
import {
  initializeRunnerRecovery,
  recordRunnerFailure,
  recoverUnavailableRunners,
  runnerRecoveryStatus,
  cleanupCharges,
  runnerExcluded,
} from './resource-recovery.js';
import { writeWhileLocked } from './pool-lock.js';
import { readGateQueueSettings } from '../../../queue/index.js';
import { pickTieredRunner } from './runner-load-pick.js';
import { troubledRunners } from './runner-load-pick.js';
import { reservedTimingRunner } from './runner-timing-reserve.js';
import { timingReserveAllows } from './runner-timing-reserve.js';
import { platformIdentity } from './holder-liveness.js';
import { differentStart } from './holder-liveness.js';
import { pollingNow } from './runner-placement.js';
import { requiredRunnerHosts } from './runner-placement.js';
import { runnerAllowed } from './runner-placement.js';
import { runnerAllowedNow } from './runner-placement.js';
export { ADMISSION_POLL_FRESH_MS } from './runner-placement.js';
import {
  localWaitBranch,
  runnerDeadlineLine,
  runnerWaitReasons,
  runnerWaitLine,
} from './runner-wait-reasons.js';
import {
  ARRIVAL_ORDER,
  classedMarker,
  classOrderInEffect,
  orderedWaiters,
  queueClass,
  releaseOrderInEffect,
} from '../../../queue/index.js';
export { QUEUE_CLASSES, QUEUE_AGE_MS, queueClass } from '../../../queue/index.js';

const LEASE_MS = 20_000;
const GATE_WAITER_HEARTBEAT_MS = 120_000;
const HEARTBEAT_MS = 3_000;
const POLL_MS = 40;
const PROCESS_IDENTITY_CACHE_MS = 3_000;
const processIdentities = new Map();
const queueFiles = new WeakMap(); // Each open queue database's file: every write joins that file's ordered write queue [C7,#3084].
const SLOT_DB_BUSY_MS = 10_000;
/** How long a queued run keeps retrying a locked slot database before it stops, never having run. */
export const SLOT_DB_LOCK_DEADLINE_MS = 300_000;
/** Overrides that deadline in milliseconds; tests use it to reach the deadline quickly. */
export const SLOT_DB_LOCK_ENV = 'PULLBOARD_SLOT_DB_LOCK_MS';
/** The exit status of a run that never started because the slot database stayed locked (EX_TEMPFAIL). */
export const NEVER_RAN_EXIT_CODE = 75;
/** Mark child commands whose parent already owns a machine gate slot. */
export const GATE_SLOT_HELD_ENV = 'PULLBOARD_GATE_SLOT_HELD';
export const GATE_SLOT_POOL_ENV = 'PULLBOARD_GATE_SLOT_POOL';
export const GATE_SLOT_TOKEN_ENV = 'PULLBOARD_GATE_SLOT_TOKEN';
export const BROWSER_SLOT_HELD_ENV = 'PULLBOARD_BROWSER_SLOT_HELD';
/** Where a runner asks the lease guard to record its own browser-slot refusal (#1043). */
export const BROWSER_REFUSAL_FILE_ENV = 'PULLBOARD_BROWSER_REFUSAL_FILE';

/** Reserve a distinct resource row for each configured remote host. */
function runnerResourceName(host) { return `runner:${host}`; }

/** Build child markers that identify the exact machine queue lease and its browser capacity. */
export function gateSlotEnvironment(lease) {
  if (lease?.runner) throw new Refused('REMOTE_GATE_SLOT_NOT_INHERITABLE', 'remote runner leases cannot be inherited through local gate markers');
  if (!lease || lease.name !== 'gate' || lease.scope !== 'machine' || typeof lease.pool !== 'string' || typeof lease.token !== 'string') {
    throw new Refused('GATE_SLOT_LEASE_REQUIRED', 'pass the live machine gate lease when starting a child test process');
  }
  return {
    [GATE_SLOT_HELD_ENV]: '1',
    [GATE_SLOT_POOL_ENV]: lease.pool,
    [GATE_SLOT_TOKEN_ENV]: lease.token,
    [BROWSER_SLOT_HELD_ENV]: lease.browser ? '1' : '',
  };
}
/** Resolve the local database for the requested scope. */
function databaseFile(scope, root) {
  if (scope === 'board') throw new Refused('BOARD_SCOPE_UNAVAILABLE', 'board-scoped resources need the relay; run pullboard relay on');
  if (scope === 'machine') return machineResourceFile();
  if (scope === 'repo') return join(repoInfo(root).commonDir, 'pullboard', 'resources.sqlite');
  throw new Refused('BAD_RESOURCE_SCOPE', `unknown resource scope "${scope}"; use machine or repo`);
}

/** Resolve the database path for the machine-wide resource pool. */
function machineResourceFile() {
  return join(machineHome(), 'resources.sqlite');
}

/** Canonicalize an absolute resource path without creating a missing foreign pool. */
function canonicalResourceFile(file) {
  let candidate = resolve(file);
  const missing = [];
  while (true) {
    try {
      return resolve(realpathSync(candidate), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/** Open and initialize the small durable queue database, or hand back the process's one retained connection when reuse is on [C7,#3338]. */
function open(file, machine = false) { return retainConnection(file, () => machine ? withMachineHomeWrite(machineHome(), () => openQueue(file)) : openQueue(file)); }

/** Initialize a queue, leaving machine-storage error translation to its caller. */
function openQueue(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  queueFiles.set(db, file);
  let transaction = false, leave;
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${Math.min(SLOT_DB_BUSY_MS, slotLockDeadlineMs())}`); // WAL: readers never wait on the census writer; inside the try so a lock here closes the handle [C7,#3338].
    leave = enterResourceQueue(file, { apply: queuedWrites(db), deadlineMs: slotLockDeadlineMs() });
    beginResourceWrite(db, { file, timeoutMs: Math.min(SLOT_DB_BUSY_MS, slotLockDeadlineMs()) });
    transaction = true;
    db.exec(`CREATE TABLE IF NOT EXISTS resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', runner TEXT NOT NULL DEFAULT '', short_slot INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS holder_name ON holder(name);
      CREATE TABLE IF NOT EXISTS liveness_event (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, item TEXT NOT NULL DEFAULT '', pid INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', remote INTEGER NOT NULL DEFAULT 0, short_eligible INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runner_unavailable (host TEXT PRIMARY KEY, since TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS runner_rotation (pool TEXT PRIMARY KEY, next_host TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS runner_gui (host TEXT PRIMARY KEY, gui INTEGER, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_draining (host TEXT PRIMARY KEY, runner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_timing_drain (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, host TEXT NOT NULL, since TEXT NOT NULL, wait_ms INTEGER NOT NULL, stage TEXT NOT NULL, agent TEXT NOT NULL, item TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_timing_event (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL, item TEXT NOT NULL, wait_ms INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS waiter_name_ticket ON waiter(name, ticket);`);
    initializeRunnerRecovery(db);
    for (const table of ['holder', 'waiter']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (table === 'waiter' && !columns.includes('required_executor')) db.exec("ALTER TABLE waiter ADD COLUMN required_executor TEXT NOT NULL DEFAULT ''");
      if (table === 'waiter' && !columns.includes('runner_only')) db.exec('ALTER TABLE waiter ADD COLUMN runner_only INTEGER NOT NULL DEFAULT 0');
      if (table === 'holder' && !columns.includes('runner_execution')) db.exec('ALTER TABLE holder ADD COLUMN runner_execution INTEGER NOT NULL DEFAULT 0');
      if (table === 'holder' && !columns.includes('controller_identity')) db.exec("ALTER TABLE holder ADD COLUMN controller_identity TEXT NOT NULL DEFAULT ''");
      if (!columns.includes('timing_aware')) db.exec(`ALTER TABLE ${table} ADD COLUMN timing_aware INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('timing')) db.exec(`ALTER TABLE ${table} ADD COLUMN timing INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('started')) db.exec(`ALTER TABLE ${table} ADD COLUMN started TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('landing')) db.exec(`ALTER TABLE ${table} ADD COLUMN landing INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('item_check')) db.exec(`ALTER TABLE ${table} ADD COLUMN item_check INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('diagnostic')) db.exec(`ALTER TABLE ${table} ADD COLUMN diagnostic INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('browser')) db.exec(`ALTER TABLE ${table} ADD COLUMN browser INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('item')) db.exec(`ALTER TABLE ${table} ADD COLUMN item TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('kind')) db.exec(`ALTER TABLE ${table} ADD COLUMN kind TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('lease_until')) db.exec(`ALTER TABLE ${table} ADD COLUMN lease_until TEXT NOT NULL DEFAULT ''`);
      if (table === 'holder' && !columns.includes('runner')) db.exec("ALTER TABLE holder ADD COLUMN runner TEXT NOT NULL DEFAULT ''");
      if (table === 'holder' && !columns.includes('short_slot')) db.exec('ALTER TABLE holder ADD COLUMN short_slot INTEGER NOT NULL DEFAULT 0');
      if (table === 'holder' && !columns.includes('terminating')) db.exec('ALTER TABLE holder ADD COLUMN terminating INTEGER NOT NULL DEFAULT 0');
      if (table === 'holder' && !columns.includes('request')) db.exec("ALTER TABLE holder ADD COLUMN request TEXT NOT NULL DEFAULT ''");
      if (table === 'holder' && !columns.includes('relaunched')) db.exec('ALTER TABLE holder ADD COLUMN relaunched INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('gui')) db.exec('ALTER TABLE waiter ADD COLUMN gui INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('remote')) db.exec('ALTER TABLE waiter ADD COLUMN remote INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('short_eligible')) db.exec('ALTER TABLE waiter ADD COLUMN short_eligible INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('memory_held')) db.exec('ALTER TABLE waiter ADD COLUMN memory_held INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('runner_deadline')) db.exec('ALTER TABLE waiter ADD COLUMN runner_deadline INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('runner_wait_branch')) db.exec("ALTER TABLE waiter ADD COLUMN runner_wait_branch TEXT NOT NULL DEFAULT ''");
      if (table === 'waiter' && !columns.includes('runner_wait_reasons')) db.exec("ALTER TABLE waiter ADD COLUMN runner_wait_reasons TEXT NOT NULL DEFAULT '[]'");
      if (table === 'waiter' && !columns.includes('polled')) db.exec('ALTER TABLE waiter ADD COLUMN polled INTEGER NOT NULL DEFAULT 0');
    }
    pinLegacyReclaimInputs(db); // Older reclaim timers never fire [#3164]. Older clients insert the default zero. A trigger witnesses short legacy
    // arrivals between the timing owner's polls; no old client has to understand the new flag.
    db.exec(`CREATE TABLE IF NOT EXISTS timing_client_observation (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL);`);
    if (!db.prepare('PRAGMA table_info(timing_client_observation)').all().some(({ name }) => name === 'name')) {
      db.exec("ALTER TABLE timing_client_observation ADD COLUMN name TEXT NOT NULL DEFAULT 'gate'");
    }
    // Replace both old trigger definitions atomically, so no concurrent arrival is unwitnessed.
    if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='timing_unaware_holder'").get()?.sql.includes("runner:*")
      || !db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='timing_unaware_waiter'").get()?.sql.includes("runner:*")) db.exec(`DROP TRIGGER IF EXISTS timing_unaware_holder;
      DROP TRIGGER IF EXISTS timing_unaware_waiter;
      CREATE TRIGGER timing_unaware_holder AFTER INSERT ON holder
      WHEN (NEW.name = 'gate' OR NEW.name GLOB 'runner:*') AND NEW.timing_aware = 0 BEGIN
        INSERT INTO timing_client_observation(agent,pid,started,name) VALUES (NEW.agent,NEW.pid,NEW.started,NEW.name);
      END;
      CREATE TRIGGER timing_unaware_waiter AFTER INSERT ON waiter
      WHEN (NEW.name = 'gate' OR NEW.name GLOB 'runner:*') AND NEW.timing_aware = 0 BEGIN
        INSERT INTO timing_client_observation(agent,pid,started,name) VALUES (NEW.agent,NEW.pid,NEW.started,NEW.name);
      END;`);
    // No live timing admission can need observations once its holder and waiter rows are gone.
    db.exec(`DELETE FROM timing_client_observation
      WHERE NOT EXISTS (SELECT 1 FROM holder WHERE timing = 1)
        AND NOT EXISTS (SELECT 1 FROM waiter WHERE timing = 1)`);
    // Marks a waiter whose process admits by class; an older pullboard leaves it 0.
    if (!db.prepare('PRAGMA table_info(waiter)').all().some(({ name }) => name === 'classed')) {
      db.exec('ALTER TABLE waiter ADD COLUMN classed INTEGER NOT NULL DEFAULT 0');
    }
    for (const [column, definition] of [['release_aware', 'INTEGER NOT NULL DEFAULT 0'], ['board_key', "TEXT NOT NULL DEFAULT ''"], ['release_rank', 'INTEGER NOT NULL DEFAULT 9007199254740991'], ['queue_ticket', 'INTEGER']]) {
      if (!db.prepare('PRAGMA table_info(waiter)').all().some(({ name }) => name === column)) {
        db.exec(`ALTER TABLE waiter ADD COLUMN ${column} ${definition}`);
      }
    }
    // Older runner-aware builds stored remote leases as ordinary gate holders. Move them
    // into their host namespace so old readers of name='gate' continue to see local use only.
    db.exec(`INSERT INTO resource(name, capacity)
      SELECT 'runner:' || runner, MAX(1, COUNT(*)) FROM holder
      WHERE name = 'gate' AND runner <> '' GROUP BY runner
      ON CONFLICT(name) DO NOTHING;
      UPDATE holder SET name = 'runner:' || runner WHERE name = 'gate' AND runner <> '';`);
    db.exec('COMMIT');
    transaction = false; leave();
  } catch (error) {
    if (transaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
    }
    leave?.(); db.close();
    throw resourceWriteError(error, file);
  }
  return db;
}

/** The configured slot-database lock deadline, or the default when unset or invalid. */
function slotLockDeadlineMs() {
  const value = Number(process.env[SLOT_DB_LOCK_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : SLOT_DB_LOCK_DEADLINE_MS;
}

/** Recognize SQLite's busy or locked failure, which a later attempt can pass. */
function slotDatabaseLocked(error) {
  const code = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null; // The admission refusal counts too (#C7).
  return error?.code === 'SLOT_DB_LOCKED' || code === 5 || code === 6 || /database is locked/iu.test(error?.message ?? '');
}

/** Name other processes with the database open; SQLite does not record which one holds its lock. lsof scans every process, slowly on a loaded machine, so it gets 10 s. */
function slotDatabaseOpeners(file) {
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(path => existsSync(path));
  if (!lsof) return [];
  let output = '';
  try { output = execFileSync(lsof, ['-n', '-P', '-F', 'pc', '--', file], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) { output = typeof error.stdout === 'string' ? error.stdout : ''; }
  const openers = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) openers.push({ pid: Number(line.slice(1)), command: '' });
    else if (line.startsWith('c') && openers.length) openers.at(-1).command = line.slice(1);
  }
  return openers.filter(({ pid }) => Number.isSafeInteger(pid) && pid !== process.pid);
}

/** Retry a slot-database step while another process holds the lock, with a bounded backoff, until the deadline. */
async function retryLockedSlotDatabase(file, work) {
  const deadline = slotLockDeadlineMs();
  const startedAt = Date.now();
  let backoff = POLL_MS;
  while (true) {
    try { return work(); }
    catch (error) {
      if (!slotDatabaseLocked(error)) throw error;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= deadline) {
        const openers = slotDatabaseOpeners(file);
        const holder = openers.length ? `held by one of: ${openers.map(({ pid, command }) => `pid ${pid}${command ? ` (${command})` : ''}`).join(', ')}` : 'lock holder unknown';
        const stopped = new Refused('SLOT_DB_LOCKED', `never ran: the gate slot database ${file} stayed locked for ${elapsed}ms, past the ${deadline}ms deadline (${holder}). The run did not start, so this is not a test failure; rerun it.`);
        stopped.neverRanExitCode = NEVER_RAN_EXIT_CODE;
        throw stopped;
      }
      await pause(Math.min(backoff, deadline - elapsed));
      backoff = Math.min(backoff * 2, 2_000);
    }
  }
}

/** Check whether the operating system still recognizes this process ID. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Read a stable OS process identity; an unreadable identity is unknown, not proof of death. */
function processIdentity(pid) {
  const cached = processIdentities.get(pid);
  if (cached && Date.now() - cached.checkedAt < PROCESS_IDENTITY_CACHE_MS) return cached.identity;
  let identity = null;
  try {
    const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const fields = output.split(/\s+/u);
    const state = fields.pop();
    if (fields.length) identity = { started: fields.join(' '), zombie: state?.startsWith('Z') ?? false };
  } catch { identity = platformIdentity(pid); }
  processIdentities.set(pid, { identity, checkedAt: Date.now() });
  if (processIdentities.size > 1024) {
    for (const [cachedPid, entry] of processIdentities) {
      if (Date.now() - entry.checkedAt >= PROCESS_IDENTITY_CACHE_MS) processIdentities.delete(cachedPid);
    }
  }
  return identity;
}

/** Read the start identity to store with a lease when the OS can provide it. */
function processStarted(pid) {
  return processIdentity(pid)?.started ?? '';
}

/** Confirm that a live PID still belongs to the process recorded in the lease. */
function sameProcess(pid, started) {
  if (!alive(pid)) return false;
  const identity = processIdentity(pid);
  if (!identity) return true;
  if (identity.zombie) return false;
  return !started || identity.started === started;
}

/** Recheck a cached mismatch before acting on custody; a new PID incarnation must never be mistaken for an old cache row. */
function custodyProcessMatches(pid, started) {
  if (!alive(pid)) return false;
  let identity = processIdentity(pid);
  if (identity && (identity.zombie || differentStart(identity, started))) {
    processIdentities.delete(pid);
    identity = processIdentity(pid);
  }
  return !identity || !identity.zombie && !differentStart(identity, started);
}

/** Run a short database update as this file's single queued writer, so no caller contends for the SQLite lock [C7,#3084]. */
function update(db, action) {
  const leave = enterResourceQueue(queueFiles.get(db), { apply: queuedWrites(db), deadlineMs: slotLockDeadlineMs() });
  try { return transact(db, action); } finally { leave(); }
}
/** Apply queued writes that need no answer; a release, deleting its holder, is the only one. */
function queuedWrites(db) {
  return entry => transact(db, () => { if (entry.op === 'release') { db.prepare('DELETE FROM holder WHERE token = ?').run(entry.token); removeEmptyViewPortResource(db, entry.name); } });
}
/** Run one short transaction and discard dead or expired leases. */
function transact(db, action) {
  beginResourceWrite(db, { timeoutMs: Math.min(SLOT_DB_BUSY_MS, slotLockDeadlineMs()) });
  try {
    pruneControllerOrphans(db, { sameProcess: custodyProcessMatches, recordRunnerFailure });
    const cutoff = Date.now() - LEASE_MS;
    const relaunches = reclaimHolders(db, Date.now(), { alive, processIdentity, freshIdentity: pid => { processIdentities.delete(pid); return processIdentity(pid); } });
    for (const row of db.prepare('SELECT token, name, pid, started, heartbeat FROM waiter').all()) {
      // A live but hung gate process cannot retain a queue place indefinitely.
      const staleGate = row.name === 'gate' && row.heartbeat < Date.now() - GATE_WAITER_HEARTBEAT_MS;
      if (staleGate || !alive(row.pid) || (row.heartbeat < cutoff && !sameProcess(row.pid, row.started))) {
        db.prepare('DELETE FROM waiter WHERE token = ?').run(row.token);
      }
    }
    const result = action();
    db.exec('COMMIT');
    for (const relaunch of relaunches) dispatchRelaunch(relaunch);
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original transaction failure. */ }
    throw resourceWriteError(error);
  }
}

/** Remove a view-port definition only after its last lease has left the resource queue. */
function removeEmptyViewPortResource(db, name) {
  if (!name.startsWith('view-port-')) return;
  db.prepare(`DELETE FROM resource WHERE name = ?
    AND NOT EXISTS (SELECT 1 FROM holder WHERE name = ?)
    AND NOT EXISTS (SELECT 1 FROM waiter WHERE name = ?)`)
    .run(name, name, name);
}

/** Sweep only empty view-port definitions after callers have pruned dead lease rows. */
function removeEmptyViewPortResources(db) {
  db.exec(`DELETE FROM resource WHERE name GLOB 'view-port-*'
    AND NOT EXISTS (SELECT 1 FROM holder WHERE holder.name = resource.name)
    AND NOT EXISTS (SELECT 1 FROM waiter WHERE waiter.name = resource.name)`);
}

/**
 * The admission order a pool uses now. Only the machine pool follows the machine settings
 * (gate.queue.reviewsFirst, currentReleaseFirst and agingMinutes); it is read on every poll so each process
 * sharing the pool ranks the line the same way, even right after the setting changes.
 *
 * @param {'machine'|'repo'|'board'} scope
 * @returns {{ reviewsFirst: boolean, currentReleaseFirst?: boolean, ageMs: number }}
 */
function queueOrder(scope) {
  if (scope !== 'machine') return ARRIVAL_ORDER;
  const { reviewsFirst, currentReleaseFirst, agingMinutes } = readGateQueueSettings(machineSettingsFile());
  return { reviewsFirst, currentReleaseFirst, ageMs: agingMinutes * 60_000 };
}

/** Read the complete resource line with the metadata every admission view orders identically. */
function queuedWaiters(db, name) {
  return db.prepare('SELECT ticket, token, pid, agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, gui, remote, runner_only AS runnerOnly, required_executor AS requiredExecutor, item, kind, lease_until AS leaseUntil, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible AS shortEligible, timing, memory_held AS memoryHeld, runner_deadline AS runnerDeadlineAt, runner_wait_branch AS runnerWaitBranch, runner_wait_reasons AS runnerWaitReasons, polled FROM waiter WHERE name = ?').all(name);
}

/** Current holders and the waiting line in admission order, each waiter naming its class (aged only while class order is on). */
function snapshot(db, name, order = ARRIVAL_ORDER, now = Date.now()) {
  /** Preserve older public entries while naming diagnostics as a distinct queue class. */
  const project = ({ diagnostic, browser, gui, remote, runnerOnly, requiredExecutor, runner, item, kind, leaseUntil, shortSlot, shortEligible, timing, memoryHeld, runnerDeadlineAt, runnerWaitBranch, runnerWaitReasons, ...entry }) => ({ ...entry, landing: entry.landing === 1,
    itemCheck: entry.itemCheck === 1 && diagnostic !== 1, ...(diagnostic === 1 ? { diagnostic: true } : {}),
    ...(['gate', 'browser'].includes(name) && shortSlot === 1 ? { slot: 'short' } : {}),
    ...(['gate', 'browser'].includes(name) && shortSlot === 0 ? { slot: 'gate' } : {}),
    ...(['gate', 'browser'].includes(name) && shortEligible === 1 ? { requestedSlot: 'short-eligible' } : {}),
    ...(remote === 1 && runnerWaitReasons !== '[]' ? { runnerWait: { browser: browser === 1, gui: gui === 1, timing: timing === 1, runners: JSON.parse(runnerWaitReasons) } } : {}),
    ...(runnerDeadlineAt > 0 && now >= runnerDeadlineAt ? { runnerDeadline: { at: runnerDeadlineAt, branch: runnerWaitBranch, runners: JSON.parse(runnerWaitReasons) } } : {}),
    ...(memoryHeld === 1 ? { memoryHeld: true } : {}), ...(timing === 1 ? { timing: true } : {}), ...(browser === 1 ? { browser: true } : {}), ...(gui === 1 ? { gui: true } : {}), ...(remote === 1 ? { remote: true } : {}),
    ...(requiredExecutor ? { requiredExecutor: JSON.parse(requiredExecutor) } : {}), ...(runnerOnly === 1 ? { runnerOnly: true } : {}), ...(runner ? { runner } : {}), ...(item ? { item } : {}), ...(kind ? { kind } : {}), ...(leaseUntil ? { leaseUntil } : {}) });
  // Browser is an additional capability on a gate lease, not a second partially held row.
  const where = name === 'browser' ? 'name = ? AND browser = 1' : 'name = ?';
  const sourceName = name === 'browser' ? 'gate' : name;
  const runnerHost = name.startsWith('runner:') ? name.slice('runner:'.length) : '';
  const holderWhere = runnerHost ? 'name = ?' : where;
  const holderValues = [sourceName];
  const holders = db.prepare(`SELECT agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, runner, item, kind, lease_until AS leaseUntil, short_slot AS shortSlot, timing FROM holder WHERE ${holderWhere} ORDER BY since, token`).all(...holderValues).map(project);
  const queued = queuedWaiters(db, sourceName);
  const ageMs = order.reviewsFirst ? order.ageMs : Infinity;
  const line = orderedWaiters(queued, now, order)
    .filter(entry => name !== 'browser' || entry.browser === 1)
    .map(({ ticket, token, pid, classed, release_aware, board_key, release_rank, queue_ticket, polled, ...entry }) => {
      const current = queueClass(entry, now, ageMs);
      return { ...project(entry), queueClass: current.name, ...(current.effective < current.base ? { agedFrom: current.declared } : {}) };
    });
  // With reviews first on, an older pullboard in the line means everyone admits in arrival order until it leaves.
  const timingDrain = sourceName === 'gate' ? timingDrainSnapshot(db) : null;
  const timingEvents = sourceName === 'gate' ? timingDrainEvents(db) : [];
  return { holders, line, ...(timingDrain ? { timingDrain } : {}), ...(timingEvents.length ? { timingEvents } : {}), ...((order.reviewsFirst || order.currentReleaseFirst) && !classOrderInEffect(queued, order) && queued.some((waiter) => waiter.release_aware !== 1 || (!order.currentReleaseFirst && waiter.classed !== 1)) ? { order: 'arrival' } : {}) };
}

/** Count reported or admissible queue position separately so blocked work cannot distort the visible line. */
function waiterPosition(db, name, ticket, { eligibleOnly = false, shortCapacity = 0, now = Date.now(), order = ARRIVAL_ORDER } = {}) {
  const queueName = name === 'browser' ? 'gate' : name;
  const waiters = orderedWaiters(queuedWaiters(db, queueName), now, order);
  const holders = db.prepare('SELECT pid, agent, repo FROM holder WHERE name = ?').all(queueName);
  const browserCapacity = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity ?? 1;
  const browserBusy = db.prepare("SELECT COUNT(*) AS count FROM holder WHERE name = 'gate' AND browser = 1").get().count >= browserCapacity;
  /** A live process owns its leases even if it changes descriptive agent or repository labels. */
  const holdsSlot = (waiter) => holders.some((holder) => holder.pid === waiter.pid);
  /** Leave a waiting independent landing a slot before a holder takes another lease. */
  const blockedByLanding = (waiter) => holdsSlot(waiter)
    && waiters.some((other) => other.landing === 1 && other.pid !== waiter.pid);
  const line = name === 'browser' ? waiters.filter((waiter) => waiter.browser === 1) : waiters;
  const considered = line.filter((waiter) => !blockedByLanding(waiter)
    // Browser availability affects admission only; reported positions retain every browser waiter.
    && (!eligibleOnly || name === 'browser' || waiter.browser !== 1 || !browserBusy));
  const current = line.find((waiter) => waiter.ticket === ticket);
  if (!current) return eligibleOnly ? Number.MAX_SAFE_INTEGER : line.length + 1;
  // When a configured short slot can admit this waiter past ordinary work, report its
  // position in the compatible short line, while preserving any earlier landing barrier.
  if (name === 'gate' && current.shortEligible === 1 && shortCapacity > 0) {
    const earlierLandings = line.filter((waiter) => waiter.landing === 1 && waiter.ticket < ticket);
    if (earlierLandings.length) return earlierLandings.length + 1;
    return line.filter((waiter) => waiter.shortEligible === 1 && waiter.ticket <= ticket).length;
  }
  const currentIndex = considered.findIndex((waiter) => waiter.ticket === ticket);
  if (currentIndex < 0) return eligibleOnly ? Number.MAX_SAFE_INTEGER : Math.max(2, considered.length + 1);
  return currentIndex + 1;
}

/**
 * Consume the selected run's opportunity, not its original identity ticket. Persist every
 * exchange before deleting that run, or another run from its board could consume the same
 * early position again and jump a different board. Called inside the admission transaction.
 */
function consumeOpportunity(db, name, ticket, order, now) {
  const queued = queuedWaiters(db, name);
  if (!releaseOrderInEffect(queued, order)) return ticket;
  const line = orderedWaiters(queued, now, order);
  for (const entry of line) {
    db.prepare('UPDATE waiter SET queue_ticket = ? WHERE ticket = ?').run(entry.queue_ticket ?? entry.ticket, entry.ticket);
  }
  const selected = line.find(entry => entry.ticket === ticket);
  return selected?.queue_ticket ?? ticket;
}

/** Validate the configured remote executors before using them in a queue transaction. */
function validatedRunners(value) {
  if (!Array.isArray(value)) throw new Refused('BAD_RUNNER_POOL', 'runnerProvider must return an array of runner settings');
  const seen = new Set();
  return value.map((runner) => {
    if (!runner || typeof runner.host !== 'string' || !runner.host.trim() || runner.host.trim() !== runner.host
      || !Number.isSafeInteger(runner.slots) || runner.slots < 1
      || !Number.isSafeInteger(runner.browser) || runner.browser < 0 || runner.browser > runner.slots
      || seen.has(runner.host) || runner.gui !== undefined && runner.gui !== null && typeof runner.gui !== 'boolean') {
      throw new Refused('BAD_RUNNER_POOL', 'runners require unique nonempty hosts, positive slots, and browser capacity from zero through slots');
    }
    seen.add(runner.host);
    return { host: runner.host, slots: runner.slots, browser: runner.browser, ...(runner.cpuLoad ? { cpuLoad: runner.cpuLoad } : {}), ...(Number.isSafeInteger(runner.cores) ? { cores: runner.cores } : {}), ...(runner.gui !== undefined ? { gui: runner.gui } : {}),
      ...(typeof runner.node === 'string' ? { node: runner.node } : {}),
      ...(typeof runner.root === 'string' ? { root: runner.root } : {}) };
  });
}

/**
 * Find the earliest compatible free executor while allowing CPU waiters past browser-only blocks.
 * Local and remote slots are offered in one admission order, the rank that snapshot and
 * waiterPosition report: landings first and then arrival by default, or, where the machine sets
 * gate.queue.reviewsFirst, the class rank (landing, review, submit, other, aging up) FIFO by ticket
 * within a class, back to arrival while an older pullboard waits in the line. Why one order: a
 * second order for runners would let a focused run take a remote slot ahead of a review that
 * could also run there.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} ticket - The waiter asking for admission.
 * @param {number} capacity - Local gate slots.
 * @param {Array<{host:string,slots:number,browser:number}>} runners - Validated remote executors.
 * @param {{ reviewsFirst: boolean, ageMs: number }} [order] - The pool's admission order setting.
 * @param {number} [now] - The clock reading to age against.
 * @returns {{host:string,slots:number,browser:number}|null}
 */
function gateAdmission(db, ticket, capacity, shortCapacity, runners, runnersFirst = false, order = ARRIVAL_ORDER, now = Date.now(), memoryHeld = false, loadPolicy = {}) {
  const { line: waiters, overdue } = overdueSeatTestsFirst(orderedWaiters(queuedWaiters(db, 'gate'), now, order), now), testSeats = holdingTestSeats(db);
  const holders = db.prepare("SELECT pid, landing, browser, short_slot AS shortSlot, timing FROM holder WHERE name = 'gate'").all();
  let localUsed = holders.filter(holder => holder.shortSlot !== 1).length, localShortUsed = holders.filter(holder => holder.shortSlot === 1).length;
  let localBrowsers = holders.filter(holder => holder.browser === 1).length;
  const browserCapacity = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity ?? 1;
  const usage = new Map(runners.map(runner => {
    // The reserved namespace is authoritative even for an older generic holder that
    // predates the name guard and has no runner column value.
    const remoteHolders = db.prepare('SELECT browser, timing, since, landing, kind FROM holder WHERE name = ?').all(runnerResourceName(runner.host));
    const readAt = Date.parse(runner.cpuLoad?.at);
    return [runner.host, {
      slots: remoteHolders.length + (cleanupCharges(db).get(runner.host) ?? 0),
      admittedSince: /* started after the reading, so its load average cannot show them yet */ remoteHolders.filter(holder => !(Date.parse(holder.since) <= readAt)).length,
      timing: remoteHolders.some(holder => holder.timing === 1),
      browsers: remoteHolders.filter(holder => holder.browser === 1).length, landingShards: remoteHolders.filter(holder => holder.kind === 'landing' || holder.landing === 1).length, // Spread a batch's shards across hosts [C7].
    }];
  }));
  const unavailable = unavailableRunnerHosts(db, now, runners);
  const troubled = loadPolicy.enabled === true ? troubledRunners(db, now, LEASE_MS) : new Set();
  const reserved = reservedTimingRunner(db, runners, unavailable, loadPolicy.timingRunner, now, waiters.find(waiter => waiter.ticket === ticket)); // #2512: replaces the drain
  let drain = reserved ? null : currentTimingDrain(db, waiters, runners, unavailable, now);
  /** Keep an already holding process from taking another slot ahead of a different landing. */
  const blockedByLanding = waiter => holders.some(holder => holder.pid === waiter.pid)
    && waiters.some(other => other.landing === 1 && other.pid !== waiter.pid);
  /** Find a currently free compatible slot without reserving it for later queue entries. */
  function available(waiter) {
    if (blockedByLanding(waiter)) return null;
    const seatTest = isSeatTest(waiter.kind), reserve = seatTest && !overdue.has(waiter.token); // an overdue test may take the spare slot
    if (seatTest && testSeats.has(JSON.stringify([waiter.repo, waiter.agent]))) return null;
    /** Pick an eligible runner in durable round-robin order when the machine opts in. */
    function runnerSlot() {
      if (waiter.remote !== 1 || waiter.requiredExecutor && JSON.parse(waiter.requiredExecutor).kind === 'local') return null;
      const cursor = runnersFirst ? db.prepare("SELECT next_host FROM runner_rotation WHERE pool = 'gate'").get()?.next_host : '';
      const start = Math.max(0, runners.findIndex(runner => runner.host === cursor));
      const ordered = runnersFirst ? [...runners.slice(start), ...runners.slice(0, start)] : runners;
      /** Whether this runner has a free compatible slot; with the line, it asks the kept timing runner to lend one [C7,#3500]. */
      const fits = (runner, lendingTo) => {
        if (!runnerAllowedNow(waiter, runner, runners, unavailable) || !timingReserveAllows(reserved, waiter, runner, lendingTo) || !runnerCompatible(db, runner, waiter, unavailable)) return false;
        const used = usage.get(runner.host), drained = drain && (waiter.token === drain.token ? runner.host !== drain.host : runner.host === drain.host);
        return !drained && !used.timing && (waiter.timing !== 1 || used.slots === 0)
          && used.slots < runner.slots - Number(reserve && runner.slots > 1) && (waiter.browser !== 1 || used.browsers < runner.browser);
      };
      const free = ordered.filter(runner => fits(runner)), compatible = free.length ? free : ordered.filter(runner => fits(runner, waiters));
      const restriction = waiter.requiredExecutor && JSON.parse(waiter.requiredExecutor);
      // An explicit preference wins when available; fallback hosts retain existing queue ordering/balancing.
      if (restriction?.kind === 'ssh' && restriction.hosts) {
        compatible.sort((left, right) => Number(right.host === restriction.host) - Number(left.host === restriction.host));
      } else if (!runnersFirst && waiter.landing === 1) {
        // Existing landing balancing stays intact when the opt-in rotation is off.
        compatible.sort((left, right) => usage.get(left.host).slots - usage.get(right.host).slots);
      }
      if (!compatible.length) return null;
      let selected = compatible[0], dispatch;
      if (loadPolicy.enabled === true) {
        // Live load: skip overloaded runners, prefer healthy ones, take the most headroom, or queue (#2509).
        ({ selected, dispatch } = pickTieredRunner(compatible, troubled, waiter.browser === 1, host => usage.get(host), loadPolicy, now));
        if (!selected) return null;
      } else if (waiter.browser !== 1 && compatible.some(runner => runner.browser === 0)
        && !(restriction?.kind === 'ssh' && restriction.hosts && compatible[0].host === restriction.host)) {
        // Flexible work preserves browser capacity whenever a compatible browser-free host is available,
        // except that a free explicitly preferred host keeps its place [Q1,Q2,E27].
        selected = compatible.find(runner => runner.browser === 0);
      }
      const observed = db.prepare('SELECT gui FROM runner_gui WHERE host = ?').get(selected.host);
      return { ...selected, ...(dispatch ? { dispatch } : {}), ...(observed ? { gui: observed.gui === null ? null : observed.gui === 1 } : {}), shortSlot: false };
    }
    /** The local slot follows runner admission only while runner-first is enabled. */
    function localSlot() {
      if (memoryHeld || waiter.requiredExecutor && JSON.parse(waiter.requiredExecutor).kind === 'ssh') return null;
      if (!holders.some(holder => holder.timing === 1) && (waiter.timing !== 1 || holders.length === 0)
        && localUsed < capacity - Number(reserve && capacity > 1) && (waiter.browser !== 1 || localBrowsers < browserCapacity)) {
        return { host: '', slots: capacity, browser: waiter.browser === 1 ? 1 : 0, shortSlot: false };
      }
      return null;
    }
    const remote = runnerSlot();
    if (waiter.runnerOnly === 1 || reserved && waiter.timing === 1 && waiter.remote === 1) return remote; // timed work waits for the kept runner
    if (runnersFirst) {
      if (remote) return remote;
      const local = localSlot();
      if (local) return local;
    } else {
      const local = localSlot();
      if (local) return local;
      if (remote) return remote;
    }
    const earlierLanding = waiters.some(other => other.landing === 1 && other.ticket < waiter.ticket);
    if ((!waiter.requiredExecutor || JSON.parse(waiter.requiredExecutor).kind === 'local') && !memoryHeld && waiter.timing !== 1 && !holders.some(holder => holder.timing === 1)
      && waiter.shortEligible === 1 && !earlierLanding && localShortUsed < shortCapacity - Number(reserve && shortCapacity > 1)
      && (waiter.browser !== 1 || localBrowsers < browserCapacity)) {
      return { host: '', slots: shortCapacity, browser: waiter.browser === 1 ? 1 : 0, shortSlot: true };
    }
    return null;
  }
  for (const runner of runners) {
    const resourceName = runnerResourceName(runner.host);
    const row = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(resourceName);
    const held = usage.get(runner.host).slots;
    if (!row) db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?)').run(resourceName, runner.slots);
    else if (row.capacity !== runner.slots) {
      if (held > runner.slots) throw new Refused('RUNNER_CAPACITY_MISMATCH', `runner ${runner.host} has ${held} active slot(s), more than configured capacity ${runner.slots}`);
      db.prepare('UPDATE resource SET capacity = ? WHERE name = ?').run(runner.slots, resourceName);
    }
  }
  if (!drain && !reserved) {
    for (const waiter of waiters) {
      const waited = now - Date.parse(waiter.since);
      if (waiter.timing !== 1 || waiter.remote !== 1 || !Number.isFinite(waited) || waited < 120_000
        || blockedByLanding(waiter) || available(waiter)) continue;
      const candidates = runners.filter(runner => (!waiter.requiredExecutor || JSON.parse(waiter.requiredExecutor).kind === 'ssh'
        && runnerAllowed(waiter, runner)) && runnerCompatible(db, runner, waiter, unavailable)
        && !usage.get(runner.host).timing).sort((a, b) => usage.get(a.host).slots - usage.get(b.host).slots);
      if (!candidates.length) continue;
      drain = { token: waiter.token, host: candidates[0].host, since: new Date(now).toISOString(), wait_ms: waited, stage: 'draining', agent: waiter.agent, item: waiter.item };
      db.prepare("INSERT INTO runner_timing_drain VALUES(1,?,?,?,?,?,?,?)").run(drain.token, drain.host, drain.since, waited, drain.stage, drain.agent, drain.item);
      timingDrainEvent(db, 'drain-start', drain, waiter, now);
      break;
    }
  }
  for (const waiter of waiters) {
    // An earlier waiter that is not polling cannot take a slot now, so it never holds one from a later waiter [C7,#3692].
    if (waiter.ticket !== ticket && !pollingNow(waiter, now)) continue;
    const executor = available(waiter);
    if (executor) {
      if (waiter.ticket !== ticket) {
        if (isSeatTest(waiter.kind)) testSeats.add(JSON.stringify([waiter.repo, waiter.agent]));
        // Reserve one hypothetical slot for each earlier eligible waiter; an idle second slot
        // remains usable even while that earlier process has not polled again.
        if (executor.host) {
          const used = usage.get(executor.host);
          used.slots += 1;
          used.admittedSince += 1;
          used.browsers += Number(waiter.browser === 1);
          used.timing ||= waiter.timing === 1;
        } else {
          if (executor.shortSlot) localShortUsed += 1; else localUsed += 1;
          localBrowsers += Number(waiter.browser === 1);
          holders.push({ pid: waiter.pid, landing: waiter.landing, browser: waiter.browser, timing: waiter.timing });
        }
        continue;
      }
      if (drain?.token === waiter.token) {
        timingDrainEvent(db, executor.host === drain.host ? 'exclusive-admitted' : 'drain-cancel', drain, waiter, now, executor.host === drain.host ? '' : 'another executor admitted');
        if (executor.host === drain.host) db.prepare("UPDATE runner_timing_drain SET stage='exclusive' WHERE singleton=1").run();
        else db.prepare('DELETE FROM runner_timing_drain WHERE singleton=1').run();
      }
      if (runnersFirst && executor.host) {
        const selected = runners.findIndex(runner => runner.host === executor.host);
        const nextHost = runners[(selected + 1) % runners.length]?.host ?? '';
        db.prepare("INSERT INTO runner_rotation(pool, next_host) VALUES ('gate', ?) ON CONFLICT(pool) DO UPDATE SET next_host = excluded.next_host").run(nextHost);
      }
      return executor;
    }
  }
  return null;
}

/** Append queue-local audit evidence; it grants no board or runner authority. */
function timingDrainEvent(db, kind, drain, owner, now, reason = '') {
  db.prepare('INSERT INTO runner_timing_event(at,kind,host,agent,item,wait_ms,reason) VALUES(?,?,?,?,?,?,?)')
    .run(new Date(now).toISOString(), kind, drain.host, owner?.agent ?? drain.agent, owner?.item ?? drain.item, drain.wait_ms, reason);
}

/** Keep one reservation through its exclusive hold; cancellation and configuration changes never strand a host. */
function currentTimingDrain(db, waiters, runners, unavailable, now) {
  const drain = db.prepare('SELECT * FROM runner_timing_drain WHERE singleton=1').get();
  if (!drain) return null;
  const owner = waiters.find(waiter => waiter.token === drain.token);
  const held = db.prepare("SELECT agent,item FROM holder WHERE token=? AND name=? AND timing=1").get(drain.token, runnerResourceName(drain.host));
  if (held) return drain;
  const runner = runners.find(runner => runner.host === drain.host);
  if (owner?.timing === 1 && owner.remote === 1 && runner
    && (!owner.requiredExecutor || JSON.parse(owner.requiredExecutor).kind === 'ssh' && runnerAllowed(owner, runner))
    && runnerCompatible(db, runner, owner, unavailable)) return drain;
  timingDrainEvent(db, drain.stage === 'exclusive' ? 'exclusive-finished' : 'drain-cancel', drain, owner, now,
    owner ? 'executor no longer compatible' : 'request or holder left the queue');
  db.prepare('DELETE FROM runner_timing_drain WHERE singleton=1').run();
  return null;
}

/** Project only live owner metadata, never a lease token, and bound the displayed queue-local event history. */
function timingDrainSnapshot(db) {
  const drain = db.prepare('SELECT host,since,wait_ms AS waitMs,stage,token FROM runner_timing_drain WHERE singleton=1').get();
  if (!drain) return null;
  const owner = db.prepare('SELECT agent,item FROM waiter WHERE token=? UNION ALL SELECT agent,item FROM holder WHERE token=? LIMIT 1').get(drain.token, drain.token);
  if (!owner) return null;
  const { token, ...visible } = drain;
  return { ...visible, ...owner };
}

/** Keep completed drain evidence readable after its live reservation disappears, without exposing tokens. */
function timingDrainEvents(db) {
  return db.prepare('SELECT at,kind,host,agent,item,wait_ms AS waitMs,reason FROM runner_timing_event ORDER BY id DESC LIMIT 8').all().reverse();
}

/** Start due health work on its own connection so a free executor never waits for another host's probe. */
function startRunnerRecovery(db, file, runners, probe, idleProbe, restartProbe, leakProbe, transportProbe) {
  if (typeof probe !== 'function' || !db.prepare('SELECT 1 FROM runner_unavailable WHERE probe_after<=? AND probe_until<=? LIMIT 1').get(Date.now(), Date.now())) return;
  let recovery;
  try { recovery = open(file); }
  catch { process.stderr.write('runner recovery storage unavailable; failed hosts remain unavailable\n'); return; }
  void recoverUnavailableRunners(recovery, runners, { probe, idleProbe, restartProbe, leakProbe, transportProbe }).finally(() => recovery.close())
    .catch(() => process.stderr.write('runner recovery observation unavailable; failed hosts remain unavailable\n'));
}

/** Exclude quarantined hosts; an unverified cleanup costs only its slot until every slot is charged. */
function unavailableRunnerHosts(db, now, runners = []) {
  const charges = cleanupCharges(db), slots = new Map(runners.map(runner => [runner.host, runner.slots]));
  return new Set([
    // A cleanup or transport doubt excludes the runner only once its transport probes quarantine it [C7,P7].
    ...db.prepare('SELECT * FROM runner_unavailable').all()
      .filter(row => runnerExcluded(db, row, { charges, slots, now })).map(row => row.host),
    ...db.prepare('SELECT host FROM runner_draining').all().map(row => row.host),
  ]);
}

/** Capability/availability permits a remote executor even when every compatible slot is currently busy. */
function runnerCompatible(db, runner, waiter, unavailable) {
  const observed = db.prepare('SELECT gui FROM runner_gui WHERE host = ?').get(runner.host);
  const gui = observed ? observed.gui === 1 : runner.gui === true;
  return !unavailable.has(runner.host) && (waiter.browser !== 1 || runner.browser >= 1) && (waiter.gui !== 1 || gui);
}

/** List configured runners with active slot usage from the same local admission database. */
export function runnerResourceStatus(runners) {
  const configured = validatedRunners(runners);
  const db = open(machineResourceFile());
  try {
    return update(db, () => {
      const visible = new Map(configured.map(runner => [runner.host, runner]));
      for (const row of db.prepare('SELECT host, runner FROM runner_draining').all()) {
        visible.set(row.host, { ...JSON.parse(row.runner), draining: true });
      }
      return [...visible.values()].flatMap(runner => {
        const holders = db.prepare('SELECT agent, repo, since, browser, item, kind, runner, timing FROM holder WHERE name = ? ORDER BY since, token')
          .all(runnerResourceName(runner.host));
        if (runner.draining && !holders.length) return [];
        const recorded = db.prepare('SELECT * FROM runner_unavailable WHERE host = ?').get(runner.host);
        const unavailable = recorded ?? null;
        const transport = db.prepare('SELECT at,diagnostic FROM runner_transport_error WHERE host=?').get(runner.host);
        let transportFailure;
        try { if (transport) transportFailure = { at: transport.at, ...JSON.parse(transport.diagnostic) }; } catch { /* Malformed legacy diagnostics remain unreported, never guessed. */ }
        const observed = db.prepare('SELECT gui, observed_at FROM runner_gui WHERE host = ?').get(runner.host);
        return [{ ...runner, gui: runner.gui ?? null, ...(observed ? { gui: observed.gui === null ? null : observed.gui === 1, guiObservedAt: observed.observed_at } : {}), inUse: holders.length, browserInUse: holders.filter(holder => holder.browser === 1).length,
          unavailable: Boolean(unavailable), ...(unavailable ? { unavailableSince: unavailable.since, unavailableReason: unavailable.detail, recoveryFailure: runnerRecoveryStatus(unavailable.failure) } : {}),
          ...(transportFailure ? { transportFailure } : {}), holders }];
      });
    });
  } finally { db.close(); }
}

/** Persist a configured host's authenticated GUI observation; unknown replaces stale positive capability. */
export function recordRunnerGui(host, gui) {
  if (typeof host !== 'string' || !host.trim() || ![true, false, null].includes(gui)) throw new Refused('BAD_RUNNER_POOL', 'runner GUI observations require a host and true, false, or unknown');
  const db = open(machineResourceFile());
  try { update(db, () => db.prepare('INSERT INTO runner_gui(host, gui, observed_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET gui = excluded.gui, observed_at = excluded.observed_at')
    .run(host, gui === null ? null : Number(gui), new Date().toISOString())); }
  finally { db.close(); }
}

/** Serialize runner changes with admission; removal may drain active leases instead of refusing. */
export function updateRunnerSettings(host, persist, { drain = false, observation = false, allowWhenHeld = null } = {}) {
  if (typeof host !== 'string' || !host.trim() || host.trim() !== host || typeof persist !== 'function') {
    throw new Refused('BAD_RUNNER_SETTINGS', 'a runner host and settings persistence callback are required');
  }
  const db = open(machineResourceFile());
  try {
    return update(db, () => {
      const resourceName = runnerResourceName(host);
      const held = db.prepare('SELECT COUNT(*) AS count FROM holder WHERE name = ?').get(resourceName).count;
      if (held && !drain && !observation && !(typeof allowWhenHeld === 'function' && allowWhenHeld())) throw new Refused('RUNNER_BUSY', `runner ${host} has ${held} active slot(s); wait for them to finish before changing its settings`);
      const draining = drain && held && db.prepare('SELECT runner FROM runner_draining WHERE host = ?').get(host);
      if (draining) return { ...JSON.parse(draining.runner), draining: true };
      const result = persist({ held });
      // A capacity observation is not cleanup evidence or an explicit host registration.
      if (observation) return result;
      if (drain && held) {
        // Dispatch settings no longer name this host. Keep its tombstone even after the last
        // release, so a stale provider cannot offer it again; explicit registration clears it.
        db.prepare('INSERT INTO runner_draining(host, runner) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET runner = excluded.runner')
          .run(host, JSON.stringify(result));
        return { ...result, draining: true };
      }
      if (Number.isSafeInteger(result?.slots) && result.slots > 0) {
        db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET capacity = excluded.capacity')
          .run(resourceName, result.slots);
      }
      db.prepare('DELETE FROM runner_unavailable WHERE host = ? AND probe_until <= ?').run(host, Date.now());
      db.prepare('DELETE FROM runner_draining WHERE host = ?').run(host);
      return result;
    });
  } finally { db.close(); }
}

/** Pause briefly between durable queue checks. */
function pause(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/** Validate an optional placement restriction without granting any executor capability. */
export function requiredExecutorOf(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind === 'local' && Object.keys(value).some(key => key !== 'kind')
    || value.kind === 'ssh' && (Object.keys(value).some(key => !['kind', 'host', 'hosts'].includes(key))
      || typeof value.host !== 'string' || !value.host.trim() || value.host.trim() !== value.host || /[\r\n\0]/u.test(value.host)
      || value.hosts !== undefined && (!Array.isArray(value.hosts) || value.hosts.length < 1 || value.hosts.length > 64
        || Reflect.ownKeys(value.hosts).length !== value.hosts.length + 1
        || Array.from({ length: value.hosts.length }, (_, index) => index).some(index => !Object.hasOwn(value.hosts, index))
        || value.hosts.some(host => typeof host !== 'string' || !host.trim() || host.trim() !== host || /[\r\n\0]/u.test(host))
        || new Set(value.hosts).size !== value.hosts.length || !value.hosts.includes(value.host)))
    || !['local', 'ssh'].includes(value.kind)) throw new Refused('BAD_RESOURCE_METADATA', 'requiredExecutor must name local or one registered SSH host');
  return value.kind === 'local' ? { kind: 'local' } : { kind: 'ssh', host: value.host,
    ...(value.hosts === undefined ? {} : { hosts: [...value.hosts] }) };
}

/**
 * Join the queue in its admission class (landing, review, submit, other), aging up over time; FIFO by ticket within a class.
 *
 * @param {{ name: string, capacity: number, loopHeartbeat?: boolean, capacityProvider?: () => number, shortCapacityProvider?: () => number, browserCapacityProvider?: () => number, scope?: 'machine'|'repo'|'board', root?: string, agent?: string, repo?: string, landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, remote?: boolean, requiredExecutor?: {kind:'local'}|{kind:'ssh',host:string,hosts?:string[]}, runnerOnly?: boolean, runnerDeadlineAt?: number, runnerExecution?: boolean, timing?: boolean, capturedRequest?: {argv: string[], cwd?: string}, runnerProvider?: () => Array<{host:string,slots:number,browser:number}>, item?: string, kind?: string, onWait?: (state: object) => any | Promise<any>, allowIdleCapacityUpdate?: boolean, memory?: () => Promise<{ checked: boolean, held: boolean, line: string, warning?: string }>, infrastructureRetry?: boolean, _resume?: object }} options - Resource identity, queue class, short-slot eligibility, optional remote executor pool and memory check. An awaited wait callback may return {leaseUntil} and then receives a final {admitted:true} callback before work starts.
 *   memory, when given, is read before each admission: a held verdict blocks ordinary and short local
 *   executors while compatible remote slots remain eligible; an unchecked one is passed to onWait once
 *   so the caller can warn.
 * @returns {Promise<{ name: string, scope: string, token: string, pool: string, browser: boolean, slotClass: 'gate'|'short', runner?: {host:string,slots:number,browser:number}, waitMs: number, release: () => void, renew: () => void, requeueRunner?: (reason?: string, options?: { local?: boolean }) => Promise<object> }>}
 */
export async function takeResource(options) {
  const { name, capacity, scope = 'machine', root = process.cwd(), allowIdleCapacityUpdate = false, allowCapacityGrowth = false, allowCapacityShrink = false, loopHeartbeat = false } = options;
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (name.startsWith('runner:')) throw new Refused('RESERVED_RUNNER_RESOURCE', 'runner resource rows are managed by the machine gate; request name "gate"');
  if (!Number.isSafeInteger(capacity) || capacity < (name === 'gate' && scope === 'machine' ? 0 : 1)) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be positive; only the machine gate accepts 0 with a registered runner');
  const landing = options.landing === true;
  const itemCheck = options.itemCheck === true;
  const shortEligible = options.shortEligible === true;
  const timing = options.timing === true;
  const diagnostic = options.diagnostic === true;
  const browser = options.browser === true;
  const gui = options.gui === true;
  const remote = options.remote === true;
  const runnerOnly = options.runnerOnly === true;
  const capturedRequest = capturedRequestOf(options.capturedRequest);
  if (options.runnerDeadlineAt !== undefined && (!Number.isSafeInteger(options.runnerDeadlineAt) || options.runnerDeadlineAt <= 0 || !runnerOnly)) throw new Refused('BAD_RESOURCE_METADATA', 'runnerDeadlineAt must be a positive captured runner-only deadline');
  const restriction = requiredExecutorOf(options.requiredExecutor);
  const requiredExecutor = restriction ? JSON.stringify(restriction) : '';
  if (restriction && (name !== 'gate' || scope !== 'machine' || restriction.kind === 'ssh' && !remote
    || restriction.kind === 'local' && runnerOnly)) throw new Refused('BAD_RESOURCE_METADATA', 'requiredExecutor conflicts with the requested gate execution policy');
  // This synchronous provider is used inside the admission transaction; callers must
  // limit it to a bounded local configuration read, never Git, process inspection or network work.
  const runnerProvider = options.runnerProvider;
  const runnersFirstProvider = options.runnersFirstProvider;
  if (runnersFirstProvider !== undefined && typeof runnersFirstProvider !== 'function') throw new Refused('BAD_RUNNER_POOL', 'runnersFirstProvider must return the machine runner-first setting');
  const item = options.item ?? '';
  const kind = options.kind ?? '';
  // withGateSlot supplies a once-captured board rank; raw resource clients may leave it unknown.
  const boardKey = typeof options.releaseContext?.board === 'string' ? options.releaseContext.board : '';
  const releaseRank = Number.isSafeInteger(options.releaseContext?.rank) && options.releaseContext.rank >= 0 ? options.releaseContext.rank : Number.MAX_SAFE_INTEGER;
  if (timing && (name !== 'gate' || scope !== 'machine')) throw new Refused('BAD_RESOURCE_METADATA', 'timing admission requires the machine gate; request name gate with scope machine and timing true');
  if (options.timing !== undefined && typeof options.timing !== 'boolean') throw new Refused('BAD_RESOURCE_METADATA', 'timing must be an explicit boolean');
  if (browser && name !== 'gate') throw new Refused('BAD_BROWSER_RESOURCE', 'browser capacity can only be acquired together with the machine gate; request name "gate" with browser: true');
  if ((remote || runnerProvider !== undefined) && name !== 'gate') throw new Refused('BAD_REMOTE_RESOURCE', 'remote executors can only be acquired together with the machine gate');
  if (runnerProvider !== undefined && typeof runnerProvider !== 'function') throw new Refused('BAD_RUNNER_POOL', 'runnerProvider must be a function returning configured runners');
  if (name === 'browser' && !browser) throw new Refused('BAD_BROWSER_RESOURCE', 'browser capacity is acquired only as part of a gate lease; request name "gate" with browser: true');
  if (typeof item !== 'string' || typeof kind !== 'string') throw new Refused('BAD_RESOURCE_METADATA', 'resource item and kind metadata must be text');
  if (landing && itemCheck) throw new Refused('BAD_RESOURCE_PRIORITY', 'a gate slot cannot be both a landing and an item check');
  if (shortEligible && (name !== 'gate' || scope !== 'machine' || landing || diagnostic)) throw new Refused('BAD_SHORT_SLOT_REQUEST', 'short gate slots are only available to named non-landing, non-diagnostic machine gate runs');
  if (diagnostic && (landing || itemCheck)) throw new Refused('BAD_RESOURCE_PRIORITY', 'a diagnostic slot cannot also be a landing or an item check');
  const file = databaseFile(scope, root);
  // A queued run waits out a locked database in place; only a lock past the deadline stops it, as never ran.
  const db = await retryLockedSlotDatabase(file, () => open(file, scope === 'machine'));
  let pool, awarenessCursor; // A throw before the admission loop owns the connection must close it [C7,#3338].
  try { pool = canonicalResourceFile(file); awarenessCursor = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM timing_client_observation').get().id; }
  catch (error) { db.close(); throw error; }
  const unfenced = new Map();
  const observedRunnerNames = new Set();
  /** Preserve every observed unfenced client throughout this admission and execution. */
  const timingEvidence = () => {
    if (!timing) return { exclusive: false, unfencedClients: [] };
    for (const runner of runnerProvider ? validatedRunners(runnerProvider()) : []) observedRunnerNames.add(runnerResourceName(runner.host));
    const observations = db.prepare(`SELECT name,agent,pid,started FROM timing_client_observation WHERE id > ?
      UNION SELECT name,agent,pid,started FROM holder WHERE timing_aware = 0
      UNION SELECT name,agent,pid,started FROM waiter WHERE timing_aware = 0`).all(awarenessCursor)
      .filter(row => row.name === 'gate' || observedRunnerNames.has(row.name))
      .map(({ agent, pid, started }) => ({ agent, pid, started }));
    for (const client of observations) unfenced.set(`${client.pid}:${client.started}:${client.agent}`, { ...client });
    return { exclusive: unfenced.size === 0, unfencedClients: [...unfenced.values()] };
  };
  try { timingEvidence(); } catch (error) { db.close(); throw error; }
  const resume = options._resume;
  const token = resume?.token ?? randomUUID();
  const requestedAt = resume?.requestedAt ?? Date.now();
  // Capture once per admission attempt; an infrastructure requeue explicitly starts a fresh attempt.
  let runnerDeadlineAt = resume?.runnerDeadlineAt ?? options.runnerDeadlineAt ?? 0;
  let runnerDispatched = resume?.runnerDispatched === true;
  let readinessFailover = resume?.readinessFailover === true;
  let lateAdmissionClosed = resume?.lateAdmissionClosed === true;
  let lateRunnerDispatch = resume?.lateRunnerDispatch ?? null;
  let priorWaitMs = resume?.priorWaitMs ?? 0;
  let waitStartedAt = resume?.waitStartedAt ?? Date.now();
  const infrastructureAttempts = [...(resume?.infrastructureAttempts ?? [])];
  const infrastructureRetryCount = resume?.infrastructureRetryCount ?? 0;
  const pid = process.pid;
  const agent = options.agent ?? process.env.PULLBOARD_AGENT ?? `pid-${pid}`;
  const started = processStarted(pid);
  let repo;
  try { repo = isSeatTest(kind) ? seatTestRepo(root, options.repo ?? repoRoot(root)) : options.repo ?? repoRoot(root); } catch (error) { db.close(); throw error; }
  let queuedAt = resume?.queuedAt ?? new Date().toISOString();
  let leaseUntil = '';
  let initialTicket = resume?.ticket;
  let lastRunnerWait = '';
  /** Record an item's lease only after its awaited owner renewal succeeds. */
  const keepItemLease = async (state, table) => {
    const result = await renewWithBeat(file, token, table === 'waiter', async () => { await options.beforeAdmission?.(); return options.onWait?.(state); });
    if (result?.leaseUntil !== undefined) {
      if (typeof result.leaseUntil !== 'string' || !Number.isFinite(Date.parse(result.leaseUntil))) {
        throw new Refused('BAD_RESOURCE_METADATA', 'the waiting item renewal must return a valid leaseUntil timestamp');
      }
      leaseUntil = result.leaseUntil;
      const changed = await retryLockedSlotDatabase(file, () => update(db, () => db.prepare(`UPDATE ${table} SET lease_until = ? WHERE token = ? AND pid = ? AND started = ?`)
        .run(leaseUntil, token, pid, started)));
      if (changed.changes !== 1) throw new Refused('RESOURCE_LEASE_LOST', 'the queued resource lease disappeared during item renewal; retry the command');
    }
  };
  try {
    await retryLockedSlotDatabase(file, () => update(db, () => {
      const currentCapacity = options.capacityProvider?.() ?? capacity;
      const currentShortCapacity = options.shortCapacityProvider?.() ?? 0;
      const configuredRunners = runnerProvider ? validatedRunners(runnerProvider()) : [];
      if (!Number.isSafeInteger(currentCapacity) || currentCapacity < (name === 'gate' && scope === 'machine' && configuredRunners.length ? 0 : 1)) {
        throw new Refused('BAD_RESOURCE_CAPACITY', `resource capacity must be positive${name === 'gate' && scope === 'machine' ? ', or 0 with a registered runner' : ''}`);
      }
      if (!Number.isSafeInteger(currentShortCapacity) || currentShortCapacity < 0) throw new Refused('BAD_SHORT_SLOTS', 'gate.shortSlots must be a whole number, 0 or more; run pullboard settings gate.shortSlots <n>');
      const row = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name);
      if (row && row.capacity !== currentCapacity) {
        const state = snapshot(db, name);
        const activeHolders = name === 'gate' ? state.holders.filter(holder => !holder.runner).length : state.holders.length;
        // Growing a pool never strands a holder, so a caller that allows growth may raise it while held (3 Nov: handoff workers grew from 4 to 10 with jobs running).
        const grows = allowCapacityGrowth && currentCapacity > row.capacity;
        // A pool whose target fell (fewer runners) may shrink: holders above it finish, new takes wait [C7,#2944].
        const shrinks = allowCapacityShrink && currentCapacity < row.capacity;
        if (!grows && !shrinks && (!allowIdleCapacityUpdate || activeHolders || state.line.length)) {
          throw new Refused('RESOURCE_CAPACITY_MISMATCH', `resource "${name}" already has capacity ${row.capacity}`);
        }
        db.prepare('UPDATE resource SET capacity = ? WHERE name = ?').run(currentCapacity, name);
      }
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, currentCapacity);
      if (name === 'gate' && scope === 'machine' && browser) {
        const browserCapacity = options.browserCapacityProvider?.() ?? 1;
        if (!Number.isSafeInteger(browserCapacity) || browserCapacity < (runnerProvider && validatedRunners(runnerProvider()).length ? 0 : 1) || browserCapacity > currentCapacity) {
          throw new Refused('BAD_BROWSER_SLOTS', `browser capacity must be a positive integer no greater than gate capacity (${currentCapacity}); run pullboard settings browserSlots <n>`);
        }
        const browserResource = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get();
        if (browserResource && browserResource.capacity !== browserCapacity) {
          const state = snapshot(db, 'browser');
          if (!(allowCapacityGrowth && browserCapacity > browserResource.capacity) && (!allowIdleCapacityUpdate || state.holders.length || state.line.length)) {
            throw new Refused('RESOURCE_CAPACITY_MISMATCH', `resource "browser" already has capacity ${browserResource.capacity}`);
          }
          db.prepare("UPDATE resource SET capacity = ? WHERE name = 'browser'").run(browserCapacity);
        }
        db.prepare("INSERT INTO resource(name, capacity) VALUES ('browser', ?) ON CONFLICT(name) DO NOTHING").run(browserCapacity);
      }
      if (!resume) {
        // Remote eligibility is metadata on this same ticket; the kind and flags decide the
        // admission class, and the ticket keeps arrival order within it.
        const inserted = db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible, gui, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote), classedMarker(queueOrder(scope)), 1, boardKey, releaseRank, resume?.queueTicket ?? null, Number(shortEligible), Number(gui), Number(timing), 1);
        db.prepare('UPDATE waiter SET required_executor = ? WHERE token = ?').run(requiredExecutor, token);
        initialTicket = Number(inserted.lastInsertRowid);
      }
    }));
    let memoryWarned = false;
    while (true) {
      const memory = options.memory ? await options.memory() : null;
      if (memory && !memory.checked && !memoryWarned) {
        memoryWarned = true;
        // Await it like every other wait report, so an item-lease callback never renews unobserved.
        await keepItemLease({ holders: [], line: [], position: 0, memory }, 'waiter');
      }
      await options.beforeAdmission?.(); const order = queueOrder(scope);
      const acquired = await retryLockedSlotDatabase(file, () => update(db, () => {
        const now = Date.now();
        // The machine-settings provider performs a bounded local JSON read. Read it
        // after taking the same SQLite write lock used by updateRunnerSettings so an
        // older pre-lock snapshot cannot overwrite a newer configured capacity.
        const runners = runnerProvider ? validatedRunners(runnerProvider()) : [];
        if (restriction?.kind === 'ssh' && !requiredRunnerHosts({ requiredExecutor: restriction }).some(host => runners.some(runner => runner.host === host))) {
          throw new Refused('BAD_RUNNER_POOL', 'none of the allowed SSH executors is registered');
        }
        const runnersFirst = runnersFirstProvider?.() === true;
        const timingReserved = name === 'gate' && timing && reservedTimingRunner(db, runners, unavailableRunnerHosts(db, now, runners), options.runnerLoadPolicyProvider?.().timingRunner, now, { remote: 1, timing: 1, requiredExecutor }); // a reserved timed check queues for its runner and its dispatch expiry never widens the executor
        if (timingReserved) runnerDeadlineAt = 0; else if (!runnerDeadlineAt && remote && (runnerOnly || runners.length) && options.runnerWaitMs) runnerDeadlineAt = requestedAt + options.runnerWaitMs;
        const runnerDeadlinePassed = runnerDeadlineAt > 0 && now >= runnerDeadlineAt;
        const waiter = db.prepare('SELECT ticket, token, remote, browser, gui, required_executor AS requiredExecutor, runner_wait_branch AS runnerWaitBranch FROM waiter WHERE token = ?').get(token);
        if (!waiter) {
          if (resume && initialTicket && name !== 'gate') {
            db.prepare('INSERT OR IGNORE INTO waiter(ticket, token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible, gui, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(initialTicket, token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote), classedMarker(order), 1, boardKey, releaseRank, resume?.queueTicket ?? null, Number(shortEligible), Number(gui), Number(timing), 1);
            db.prepare('UPDATE waiter SET required_executor = ? WHERE token = ?').run(requiredExecutor, token);
            return { acquired: false, state: { ...snapshot(db, name, order), position: waiterPosition(db, name, initialTicket, { order, shortCapacity: options.shortCapacityProvider?.() ?? 0 }), rejoined: true } };
          }
          // A removed gate ticket has lost its priority, including any saved release-order ticket.
          queuedAt = new Date().toISOString();
          const rejoined = db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible, gui, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote), classedMarker(order), 1, boardKey, releaseRank, name === 'gate' ? null : resume?.queueTicket ?? null, Number(shortEligible), Number(gui), Number(timing), 1);
          db.prepare('UPDATE waiter SET required_executor = ? WHERE token = ?').run(requiredExecutor, token);
          initialTicket = Number(rejoined.lastInsertRowid);
          return { acquired: false, state: { ...snapshot(db, name, order), position: waiterPosition(db, name, initialTicket, { order, shortCapacity: options.shortCapacityProvider?.() ?? 0 }), rejoined: true } };
        }
        // The marker follows this poll's setting, so a change mid-wait reaches every process's ranking.
        // A first free runner gets one admission opportunity at the expired queue boundary.
        // A previous dispatch or a prior fallback decision never restarts the runner wait.
        const remoteEligible = remote && (!runnerDeadlinePassed || readinessFailover || !runnerDispatched && !lateAdmissionClosed);
        db.prepare('UPDATE waiter SET heartbeat = ?, polled = ?, classed = ?, runner_only = ?, remote = ?, runner_deadline = ? WHERE token = ?')
          .run(Date.now(), now, classedMarker(order), Number(runnerOnly), Number(remoteEligible), runnerDeadlineAt, token);
        waiter.remote = Number(remoteEligible);
        const unavailable = unavailableRunnerHosts(db, now, runners);
        const memoryHeld = Boolean(memory?.held && (name !== 'gate' || waiter.remote !== 1
          || !runners.some(runner => runnerAllowed(waiter, runner) && runnerCompatible(db, runner, waiter, unavailable))));
        db.prepare('UPDATE waiter SET memory_held = ? WHERE token = ?').run(Number(memoryHeld), token);
        const limit = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name).capacity;
        let runnerDeadline;
        if (runnerDeadlineAt && (runnerDeadlinePassed || !waiter.runnerWaitBranch)) {
          const state = snapshot(db, name, order, now);
          const diagnosticRunners = restriction?.kind === 'ssh' ? runners.filter(runner => runnerAllowedNow({ requiredExecutor: restriction }, runner, runners, unavailable)) : runners;
          runnerDeadline = { at: runnerDeadlineAt, runners: runnerWaitReasons(db, diagnosticRunners, { ...waiter, timing: Number(timing) }, unavailable),
            branch: localWaitBranch({ capacity: limit, browserCapacity: options.browserCapacityProvider?.() ?? 1,
              runnerOnly, browser, timing, memoryHeld: memory?.held === true, holders: state.holders }) };
          db.prepare('UPDATE waiter SET runner_wait_branch = ?, runner_wait_reasons = ? WHERE token = ?')
            .run(runnerDeadline.branch, JSON.stringify(runnerDeadline.runners), token);
          // A read-only status may cross the clock boundary between polls. Seed its facts
          // immediately, while progress and fallback still wait for the actual deadline.
          if (!runnerDeadlinePassed) runnerDeadline = undefined;
        }
        const spot = snapshot(db, name, order, now);
        const reportPosition = waiterPosition(db, name, waiter.ticket, { order, now, shortCapacity: options.shortCapacityProvider?.() ?? 0 });
        // Local pressure blocks local executors, including short slots, but never a remote executor.
        if (name !== 'gate' && memoryHeld) return { acquired: false, state: { ...spot, position: reportPosition, memory } };
        const executor = name === 'gate'
          ? gateAdmission(db, waiter.ticket, limit, options.shortCapacityProvider?.() ?? 0, runners, runnersFirst, order, now, memory?.held === true, options.runnerLoadPolicyProvider?.())
          : (waiterPosition(db, name, waiter.ticket, { eligibleOnly: true, order, now }) === 1 && spot.holders.length < limit ? { host: '' } : null);
        // Decide from the normal ordered, capability-aware admission result before refusing.
        // If nothing can start now, close the late opportunity and retain ordinary local fallback.
        if (runnerDeadlinePassed && !executor?.host) {
          db.prepare('UPDATE waiter SET remote = 0 WHERE token = ?').run(token);
          if (!executor && (runnerOnly || restriction?.kind === 'ssh' || runnerDeadline.branch === 'no local capacity')) {
            const refused = new Refused('RUNNER_WAIT_DEADLINE', `${runnerDeadlineLine(runnerDeadline)}; ${runnerOnly ? 'register or restore a compatible runner' : 'restore safe local capacity or check the named runners'}, then retry`, runnerOnly ? 'restore or register a compatible runner with pullboard runner add, then retry' : undefined);
            refused.infrastructureAttempt = { kind: 'runner-wait', code: 'RUNNER_WAIT_DEADLINE', runners: runnerDeadline.runners };
            throw refused;
          }
        }
        if (executor) {
          const lateDispatch = runnerDeadlinePassed && executor.host ? { host: executor.host,
            queueDeadlineAt: runnerDeadlineAt, admittedAt: now, budgetMs: options.runnerWaitMs,
            startupDeadlineAt: now + options.runnerWaitMs } : null;
          const queueTicket = consumeOpportunity(db, name, waiter.ticket, order, now);
          db.prepare('DELETE FROM waiter WHERE token = ?').run(token);
          const acquiredAt = new Date().toISOString();
          const holderName = executor.host ? runnerResourceName(executor.host) : name;
          db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, runner, short_slot, timing, timing_aware, request, relaunched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, holderName, pid, started, agent, repo, acquiredAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, executor.host, Number(executor.shortSlot === true), Number(timing), 1, capturedRequest, Number(process.env[LIVENESS_RELAUNCH_ENV] === '1'));
          db.prepare('UPDATE holder SET runner_execution = ? WHERE token = ?').run(Number(options.runnerExecution === true), token);
          return { acquired: true, state: { ...spot, position: 0, ...(runnerDeadline ? { runnerDeadline } : {}) }, ticket: waiter.ticket, queueTicket, runner: executor.host ? executor : undefined, lateRunnerDispatch: lateDispatch, shortSlot: executor.shortSlot === true, capacity: limit, admittedAt: acquiredAt };
        }
        let runnerWait;
        if (name === 'gate' && waiter.remote === 1) {
          const diagnosticRunners = restriction?.kind === 'ssh' ? runners.filter(runner => runnerAllowedNow({ requiredExecutor: restriction }, runner, runners, unavailable)) : runners;
          runnerWait = { browser, gui, timing, runners: runnerWaitReasons(db, diagnosticRunners, { ...waiter, timing: Number(timing) }, unavailable) };
          db.prepare('UPDATE waiter SET runner_wait_reasons = ? WHERE token = ?').run(JSON.stringify(runnerWait.runners), token);
        }
        return { acquired: false, state: { ...spot, position: reportPosition, ...(runnerWait ? { runnerWait } : {}), ...(memoryHeld ? { memory } : {}), ...(runnerDeadline ? { runnerDeadline } : {}) } };
      }));
      lateAdmissionClosed ||= Boolean(acquired.state.runnerDeadline);
      // A missed READY grants one immediate ordered admission, never another queue wait budget.
      if (!acquired.state.rejoined) readinessFailover = false;
      if (acquired.acquired) {
        if (runnerProvider) startRunnerRecovery(db, file, validatedRunners(runnerProvider()), options.runnerHealthProbe, options.runnerIdleProbe, options.runnerRestartProbe, options.runnerLeakProbe, options.runnerTransportProbe);
        runnerDispatched ||= Boolean(acquired.runner);
        lateRunnerDispatch = acquired.lateRunnerDispatch ?? lateRunnerDispatch;
        if (acquired.state.runnerDeadline && !acquired.runner) process.stderr.write(runnerDeadlineLine(acquired.state.runnerDeadline) + '; running locally\n');
        if (acquired.lateRunnerDispatch) process.stderr.write(runnerDeadlineLine(acquired.state.runnerDeadline)
          + `; first late dispatch to ${acquired.runner.host}, startup budget ${acquired.lateRunnerDispatch.budgetMs}ms\n`);
        // Only item-lease callbacks opt into admission. Await them so no renewal remains in
        // flight during the run, and restart the ordinary item expiry from this boundary.
        if (leaseUntil) {
          try { await keepItemLease({ ...acquired.state, admitted: true }, 'holder'); }
          catch (error) {
            update(db, () => db.prepare('DELETE FROM holder WHERE token = ?').run(token));
            throw error;
          }
        }
        const acquiredWaitMs = priorWaitMs + Math.max(0, Date.now() - waitStartedAt);
        let released = false, transferred = false;
        let lost = false;
        let cancellationDiagnostic = null;
        let heartbeat;
        /** Keep the active holder lease alive while its executor is running. */
        const startHeartbeat = () => {
          heartbeat = loopHeartbeat ? undefined : setInterval(() => {
            if (released || transferred || lost) return;
            try {
              const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
              if (!changed) { lost = true; clearInterval(heartbeat); }
            } catch { /* Lease expiry remains the crash fallback. */ }
          }, HEARTBEAT_MS);
          heartbeat?.unref();
        };
        startHeartbeat();
        /** Commit deletion before closing; an owner with its own retry loop can request an immediate lock failure. */
        const release = ({ retryMs } = {}) => {
          if (released || transferred) return;
          if (!cancellationDiagnostic) enqueueResourceWrite(file, { op: 'release', token, name }, { apply: queuedWrites(db) });
          else writeWhileLocked(() => update(db, () => {
            if (cancellationDiagnostic) settleControllerCancellation(db, { token, pid, started, repo, host: acquired.runner.host }, cancellationDiagnostic, recordRunnerFailure);
            db.prepare('DELETE FROM holder WHERE token = ?').run(token);
            removeEmptyViewPortResource(db, name);
          }), { retryMs });
          released = true;
          clearInterval(heartbeat);
          db.close();
        };
        /** Stop this exact remote attempt without readmission, retaining unknown remote cleanup atomically. */
        const cancelRunner = diagnostic => {
          if (!acquired.runner || released || transferred || diagnostic?.version !== 1 || typeof diagnostic.root !== 'string') throw new Refused('RESOURCE_LEASE_LOST', 'the owned remote lease is no longer cancellable');
          cancellationDiagnostic = diagnostic;
          release();
        };
        /** Refresh this lease, or refuse if another process already evicted it. */
        const renew = () => {
          if (released || transferred || lost) throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
          if (!changed) {
            lost = true;
            clearInterval(heartbeat);
            throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          }
        };
        /** Quarantine a failed remote host and retry this exact ticket on another executor, or only locally. */
        const requeueRunner = async (reason = 'transport-lost', { local = false, quarantine = true, diagnostic: transportDiagnostic,
          infrastructureRetryCount = 0, infrastructureAttempts: priorInfrastructureAttempts = [] } = {}) => {
          if (!acquired.runner) throw new Refused('LOCAL_RUNNER_REQUEUE', 'only a remote lease can be returned to the runner queue');
          if (released || transferred) throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          transferred = true;
          clearInterval(heartbeat);
          let requeueTicket = acquired.ticket;
          let requeueOpportunity = acquired.queueTicket;
          // A failed host's pin describes the old attempt, not the replacement executor.
          const retryRestriction = quarantine && restriction?.kind === 'ssh' ? undefined : restriction;
          try {
            update(db, () => {
              const holderName = runnerResourceName(acquired.runner.host);
              const holder = db.prepare('SELECT token FROM holder WHERE token = ? AND name = ? AND runner = ?').get(token, holderName, acquired.runner.host);
              if (!holder) consumeControllerDisposition(db, { token, pid, started, repo, host: acquired.runner.host }, 'requeue');
              else recordRunnerFailure(db, acquired.runner.host, reason, transportDiagnostic, { quarantine });
              // Under the class order the run keeps its original arrival ticket, so first come, first
              // served holds within each class (and its queuedAt, so its aging). Under arrival order
              // (reviewsFirst off, or an older pullboard waiting in the line) it takes #663's front
              // ticket ahead of its landing tier, as on main.
              const requeueOrder = queueOrder(scope);
              const marker = classedMarker(requeueOrder);
              if (classOrderInEffect([...db.prepare("SELECT classed, release_aware FROM waiter WHERE name = 'gate'").all(), { classed: marker, release_aware: 1 }], requeueOrder)) {
                requeueTicket = acquired.ticket;
                requeueOpportunity = acquired.queueTicket;
              }
              else {
                const minimumTicket = db.prepare("SELECT MIN(ticket) AS ticket FROM waiter WHERE name = 'gate' AND landing = ?").get(Number(landing)).ticket;
                requeueTicket = Math.min(0, minimumTicket ?? 0) - 1;
                requeueOpportunity = requeueTicket;
              }
              db.prepare('DELETE FROM holder WHERE token = ?').run(token);
              db.prepare('INSERT INTO waiter(ticket, token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible, gui, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(requeueTicket, token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote && (!local || runnerOnly)), marker, 1, boardKey, releaseRank, requeueOpportunity, Number(shortEligible), Number(gui), Number(timing), 1);
              db.prepare('UPDATE waiter SET required_executor = ? WHERE token = ?').run(retryRestriction ? JSON.stringify(retryRestriction) : '', token);
            });
          } catch (error) {
            transferred = false;
            startHeartbeat();
            throw error;
          }
          if (reason === 'worker-unresponsive' && runnerProvider) {
            startRunnerRecovery(db, file, validatedRunners(runnerProvider()), options.runnerHealthProbe, options.runnerIdleProbe, options.runnerRestartProbe, options.runnerLeakProbe, options.runnerTransportProbe);
          }
          db.close();
          const retryingInfrastructure = infrastructureRetryCount > 0 || quarantine && reason !== 'worker-unresponsive'; // a first missed READY keeps its deadline: one bounded late start [C7,Q1,Q2]
          return takeResource({ ...options, requiredExecutor: retryRestriction ?? undefined, ...(local && !runnerOnly ? { remote: false } : {}), _resume: { token, ticket: requeueTicket ?? acquired.ticket, queueTicket: requeueOpportunity,
            queuedAt, requestedAt: retryingInfrastructure ? Date.now() : requestedAt,
            runnerDeadlineAt: retryingInfrastructure ? 0 : runnerDeadlineAt,
            runnerDispatched: retryingInfrastructure ? false : runnerDispatched,
            lateAdmissionClosed: retryingInfrastructure ? false : lateAdmissionClosed,
            lateRunnerDispatch: retryingInfrastructure ? null : lateRunnerDispatch,
            readinessFailover: reason === 'worker-unresponsive',
            priorWaitMs: acquiredWaitMs, waitStartedAt: Date.now(), infrastructureRetryCount,
            infrastructureAttempts: priorInfrastructureAttempts } });
        };
        return { name, scope, token, pool, browser, timing, runnerExecution: options.runnerExecution === true, admittedAt: acquired.admittedAt, capacity: acquired.capacity, slotClass: acquired.shortSlot ? 'short' : 'gate', ...(acquired.runner ? { runner: acquired.runner } : {}),
          ...(infrastructureAttempts.length ? { infrastructureAttempts: [...infrastructureAttempts] } : {}),
          waitMs: acquiredWaitMs, ...(runnerDeadlineAt ? { runnerWaitDeadline: acquired.lateRunnerDispatch?.startupDeadlineAt ?? runnerDeadlineAt } : {}),
          ...(lateRunnerDispatch ? { lateRunnerDispatch } : {}), release, renew, timingEvidence,
          ...(acquired.runner ? { requeueRunner, cancelRunner } : {}) };
      }
      if (acquired.state.runnerWait) {
        const line = runnerWaitLine(acquired.state.runnerWait);
        if (line !== lastRunnerWait) { process.stderr.write(line + '\n'); lastRunnerWait = line; }
      }
      if (acquired.state.runnerDeadline) process.stderr.write(runnerDeadlineLine(acquired.state.runnerDeadline) + '\n');
      await keepItemLease(acquired.state, 'waiter');
      if (runnerProvider && await recoverUnavailableRunners(db, validatedRunners(runnerProvider()), beatingProbes(options, db, token)).catch(error => { if (!slotDatabaseLocked(error)) throw error; return false; })) continue; // A busy queue skips this probe, never the wait [C7].
      await pause(POLL_MS);
    }
  } catch (error) {
    if (error?.code === 'RUNNER_WAIT_DEADLINE' && options.infrastructureRetry === true && infrastructureRetryCount < 1 && initialTicket) {
      const attempt = { kind: 'runner-wait', code: error.code, runner: error.infrastructureAttempt?.runners?.[0]?.host ?? null,
        runners: error.infrastructureAttempt?.runners ?? [], at: new Date().toISOString(), message: error.message };
      const nextAttempts = [...infrastructureAttempts, attempt];
      const waited = Math.max(0, Date.now() - waitStartedAt);
      db.close();
      return takeResource({ ...options, _resume: { token, ticket: initialTicket, queueTicket: resume?.queueTicket ?? null,
        queuedAt, requestedAt: Date.now(), runnerDeadlineAt: 0, runnerDispatched: false, lateAdmissionClosed: false,
        lateRunnerDispatch: null, priorWaitMs: priorWaitMs + waited, waitStartedAt: Date.now(),
        infrastructureRetryCount: infrastructureRetryCount + 1, infrastructureAttempts: nextAttempts } });
    }
    if (error?.code === 'RUNNER_WAIT_DEADLINE' && infrastructureAttempts.length) {
      error.infrastructureAttempts = [...infrastructureAttempts, { kind: 'runner-wait', code: error.code,
        runner: error.infrastructureAttempt?.runners?.[0]?.host ?? null, runners: error.infrastructureAttempt?.runners ?? [],
        at: new Date().toISOString(), message: error.message }];
    }
    try { update(db, () => db.prepare('DELETE FROM waiter WHERE token = ?').run(token)); } catch { /* Preserve the original error. */ }
    db.close();
    throw error;
  }
}

/** Reuse a same-machine gate lease in a child without queueing or acquiring a partial browser slot.
 * The live holder row says whether the lease is a short slot; only a run that names its test files
 * (namedFiles) may reuse one, so a whole suite started under a short check queues for a real slot.
 */
export function inheritedGateSlot({ root = process.cwd(), browser = false, namedFiles = false, timing = false } = {}) {
  // Taken by the first guard in this process, so nothing it starts (a test body) can write the receipt.
  const refusalFile = process.env[BROWSER_REFUSAL_FILE_ENV] ?? '';
  delete process.env[BROWSER_REFUSAL_FILE_ENV];
  const markedPool = process.env[GATE_SLOT_POOL_ENV] ?? '';
  const token = process.env[GATE_SLOT_TOKEN_ENV] ?? '';
  if (!markedPool && !token) return null;
  if (!markedPool) throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited gate token has no pool marker; start the child with gateSlotEnvironment(lease)');
  const pool = canonicalResourceFile(machineResourceFile());
  // A process with a different PULLBOARD_MACHINE_HOME is independent and must join its own queue.
  if (canonicalResourceFile(markedPool) !== pool) return null;
  if (process.env[GATE_SLOT_HELD_ENV] !== '1') throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited gate lease is missing its legacy held marker; start the child with gateSlotEnvironment(lease)');
  if (!token) throw new Refused('GATE_SLOT_TOKEN_REQUIRED', 'the inherited gate pool marker has no lease token; restart the child with gateSlotEnvironment(lease)');
  const db = open(pool, true);
  let holder;
  try {
    holder = update(db, () => db.prepare("SELECT browser, short_slot AS shortSlot, timing, timing_aware AS timingAware, runner_execution AS runnerExecution FROM holder WHERE name = 'gate' AND token = ?").get(token));
  } finally { db.close(); }
  if (!holder) throw new Refused('GATE_SLOT_LEASE_LOST', 'the inherited gate lease is missing or expired; remove stale gate markers or let the parent reacquire the gate slot');
  if (timing && (holder.timing !== 1 || holder.timingAware !== 1)) throw new Refused('TIMING_SLOT_REQUIRED', 'the inherited ordinary lease is not exclusive; start the timing check outside it and acquire timing true');
  const slotClass = holder.shortSlot === 1 ? 'short' : 'gate';
  if (slotClass === 'short' && !namedFiles) throw new Refused('SHORT_SLOT_FULL_SUITE', 'a run that does not name its test files cannot reuse a short gate slot; start it outside the short check so it queues for an ordinary slot');
  const expectedBrowserMarker = holder.browser === 1 ? '1' : '';
  if (process.env[BROWSER_SLOT_HELD_ENV] !== expectedBrowserMarker) throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited browser marker does not match its live gate lease; restart the child with gateSlotEnvironment(lease)');
  if (browser && holder.browser !== 1 && refusalFile) writeFileSync(refusalFile, '{"code":"BROWSER_SLOT_REQUIRED"}\n', { mode: 0o600 });
  if (browser && holder.browser !== 1) throw new Refused('BROWSER_SLOT_REQUIRED', 'the inherited gate lease does not hold the browser slot; release it and reacquire gate with browser: true before launching Chrome');
  return {
    name: 'gate', scope: 'machine', token, pool, runnerExecution: holder.runnerExecution === 1, browser: holder.browser === 1, timing: holder.timing === 1, slotClass, waitMs: 0,
    release() {}, renew() {},
  };
}

/** Whether a live process holds this exact lease token, so a child it started may act under it (#906). */
export function holdsLease({ name, scope = 'repo', root = process.cwd(), token }) {
  if (typeof token !== 'string' || !token) return false;
  const db = open(databaseFile(scope, root), scope === 'machine');
  try {
    const holder = update(db, () => db.prepare('SELECT pid FROM holder WHERE name = ? AND token = ?').get(name, token));
    return Boolean(holder) && alive(holder.pid);
  } finally { db.close(); }
}

/** Change live capacity atomically; worker synchronization may safely shrink around holders that fit while waiters remain queued. */
export function setResourceCapacity({ name, capacity, scope = 'machine', root = process.cwd(), allowZero = false, allowSafeDecrease = false, persist = () => {} }) {
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (name.startsWith('runner:')) throw new Refused('RESERVED_RUNNER_RESOURCE', 'runner resource rows are managed by the machine gate; use runner settings');
  if (!Number.isSafeInteger(capacity) || capacity < (allowZero && scope === 'machine' && ['gate', 'browser'].includes(name) ? 0 : 1)) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  const db = open(databaseFile(scope, root), scope === 'machine');
  try {
    return update(db, () => {
      const state = snapshot(db, name);
      const current = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name)?.capacity;
      const occupiedDecrease = (state.holders.length || state.line.length) && (current === undefined || capacity < current);
      if (state.holders.length > capacity || occupiedDecrease && allowSafeDecrease !== true) {
        const holders = state.holders.map(holder => `${holder.agent} (${holder.repo})`).join(', ') || 'none';
        const reason = state.holders.length > capacity
          ? `requested capacity ${capacity} is below its ${state.holders.length} active holder(s)`
          : `changing capacity ${current ?? 'unset'} to ${capacity} waits for an empty queue`;
        throw new Refused('RESOURCE_BUSY', `resource "${name}" has capacity ${current ?? 'unset'}; ${reason}; ${state.line.length} waiter(s); running: ${holders}; wait for the resource to become idle, then retry pullboard settings ${name === 'browser' ? 'browserSlots' : 'gateSlots'} ${capacity}`);
      }
      persist();
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET capacity = excluded.capacity').run(name, capacity);
      return { name, capacity };
    });
  } finally { db.close(); }
}

/** List resources and prune leases whose process died or lease expired. */
export function listResources({ scope = 'machine', root = process.cwd() } = {}) {
  const order = queueOrder(scope);
  const db = open(databaseFile(scope, root), scope === 'machine');
  try {
    return update(db, () => {
      removeEmptyViewPortResources(db);
      return db.prepare('SELECT name, capacity FROM resource ORDER BY name').all().map(({ name, capacity }) => ({ name, capacity, ...snapshot(db, name, order) }));
    });
  } finally { db.close(); }
}

/** Bind controller diagnostic custody to the resource owner's canonical process identities. */
export function controllerDeadline(owner, parentPid, sourceRoot) {
  const registration = controllerRegistrationPorts({
    pool: () => canonicalResourceFile(machineResourceFile()), open, update, processStarted,
  });
  return createControllerCustody(owner, parentPid, { processStarted, machineHome, ...registration }, sourceRoot);
}

/** Read active controller health without changing availability or releasing a holder. */
export function runnerLeaseHealth(now = Date.now()) { return controllerLeaseHealth(now, { processStarted, machineHome, sameProcess: custodyProcessMatches }); }

/** Preserve the finite-deadline projection independently of lifecycle observation failures. */
export function overdueRunnerLeases(now = Date.now()) { return runnerLeaseHealth(now).filter(row => row.deadline !== undefined); }

export { runnerBoardFile } from './controller-custody.js';
export { runnerItemState } from './controller-custody.js';
export { runnerItemSources } from './controller-custody.js';
