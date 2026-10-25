/** Machine and repository queues persist leases; landings first, then arrival order, or by class (landing, review, submit, other) aging up over time where the machine opts in [Q1,Q2,Q3]. */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  execFile,
  execFileSync,
} from 'node:child_process';
import {
  readFile,
  readlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { repoInfo } from './git.js';
import {
  machineHome,
  withMachineHomeWrite,
} from './machine-home.js';
import { Refused } from './refused.js';
import { gateQueueSettings } from './queue-settings.js';
import {
  ARRIVAL_ORDER,
  classedMarker,
  classOrderInEffect,
  orderedWaiters,
  queueClass,
  releaseOrderInEffect,
} from './queue-order.js';
export { QUEUE_CLASSES, QUEUE_AGE_MS, queueClass } from './queue-order.js';

const LEASE_MS = 20_000;
const HEARTBEAT_MS = 3_000;
const POLL_MS = 40;
const PROCESS_IDENTITY_CACHE_MS = 3_000;
const processIdentities = new Map();
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

/** Open and initialize the small durable queue database. */
function open(file, machine = false) {
  return machine ? withMachineHomeWrite(machineHome(), () => openQueue(file)) : openQueue(file);
}

/** Initialize a queue, leaving machine-storage error translation to its caller. */
function openQueue(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Math.min(SLOT_DB_BUSY_MS, slotLockDeadlineMs())}`);
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    db.exec(`CREATE TABLE IF NOT EXISTS resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', runner TEXT NOT NULL DEFAULT '', short_slot INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS holder_name ON holder(name);
      CREATE TABLE IF NOT EXISTS waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', remote INTEGER NOT NULL DEFAULT 0, short_eligible INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runner_unavailable (host TEXT PRIMARY KEY, since TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS runner_rotation (pool TEXT PRIMARY KEY, next_host TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS runner_gui (host TEXT PRIMARY KEY, gui INTEGER, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_draining (host TEXT PRIMARY KEY, runner TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS waiter_name_ticket ON waiter(name, ticket);`);
    for (const table of ['holder', 'waiter']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (table === 'waiter' && !columns.includes('runner_only')) db.exec('ALTER TABLE waiter ADD COLUMN runner_only INTEGER NOT NULL DEFAULT 0');
      if (table === 'holder' && !columns.includes('runner_execution')) db.exec('ALTER TABLE holder ADD COLUMN runner_execution INTEGER NOT NULL DEFAULT 0');
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
      if (table === 'waiter' && !columns.includes('gui')) db.exec('ALTER TABLE waiter ADD COLUMN gui INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('remote')) db.exec('ALTER TABLE waiter ADD COLUMN remote INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('short_eligible')) db.exec('ALTER TABLE waiter ADD COLUMN short_eligible INTEGER NOT NULL DEFAULT 0');
      if (table === 'waiter' && !columns.includes('memory_held')) db.exec('ALTER TABLE waiter ADD COLUMN memory_held INTEGER NOT NULL DEFAULT 0');
    }
    // Older clients insert the default zero. A database trigger witnesses even short legacy
    // arrivals between the timing owner's polls; no old client has to understand the new flag.
    db.exec(`CREATE TABLE IF NOT EXISTS timing_client_observation (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS timing_unaware_holder AFTER INSERT ON holder
      WHEN NEW.name = 'gate' AND NEW.timing_aware = 0 BEGIN
        INSERT INTO timing_client_observation(agent,pid,started) VALUES (NEW.agent,NEW.pid,NEW.started);
      END;
      CREATE TRIGGER IF NOT EXISTS timing_unaware_waiter AFTER INSERT ON waiter
      WHEN NEW.name = 'gate' AND NEW.timing_aware = 0 BEGIN
        INSERT INTO timing_client_observation(agent,pid,started) VALUES (NEW.agent,NEW.pid,NEW.started);
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
    transaction = false;
  } catch (error) {
    if (transaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
    }
    db.close();
    throw error;
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
  const code = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  return code === 5 || code === 6 || /database is locked/iu.test(error?.message ?? '');
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
  } catch { /* A live PID remains authoritative when the OS identity utility is unavailable. */ }
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

/** Return the Git root for display when the resource caller is inside a repository. */
function repoRoot(root) {
  try { return repoInfo(root).root; } catch { return ''; }
}

/** Run a short serialized database update and discard dead or expired leases. */
function update(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cutoff = Date.now() - LEASE_MS;
    for (const row of db.prepare('SELECT token, pid, started, heartbeat FROM holder').all()) {
      if (!alive(row.pid) || (row.heartbeat < cutoff && !sameProcess(row.pid, row.started))) {
        db.prepare('DELETE FROM holder WHERE token = ?').run(row.token);
      }
    }
    for (const row of db.prepare('SELECT token, pid, started, heartbeat FROM waiter').all()) {
      if (!alive(row.pid) || (row.heartbeat < cutoff && !sameProcess(row.pid, row.started))) {
        db.prepare('DELETE FROM waiter WHERE token = ?').run(row.token);
      }
    }
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
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
  const { reviewsFirst, currentReleaseFirst, agingMinutes } = gateQueueSettings();
  return { reviewsFirst, currentReleaseFirst, ageMs: agingMinutes * 60_000 };
}

/** Read the complete resource line with the metadata every admission view orders identically. */
function queuedWaiters(db, name) {
  return db.prepare('SELECT ticket, pid, agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, gui, remote, runner_only AS runnerOnly, item, kind, lease_until AS leaseUntil, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible AS shortEligible, timing, memory_held AS memoryHeld FROM waiter WHERE name = ?').all(name);
}

/** Current holders and the waiting line in admission order, each waiter naming its class (aged only while class order is on). */
function snapshot(db, name, order = ARRIVAL_ORDER, now = Date.now()) {
  /** Preserve older public entries while naming diagnostics as a distinct queue class. */
  const project = ({ diagnostic, browser, gui, remote, runnerOnly, runner, item, kind, leaseUntil, shortSlot, shortEligible, timing, memoryHeld, ...entry }) => ({ ...entry, landing: entry.landing === 1,
    itemCheck: entry.itemCheck === 1 && diagnostic !== 1, ...(diagnostic === 1 ? { diagnostic: true } : {}),
    ...(['gate', 'browser'].includes(name) && shortSlot === 1 ? { slot: 'short' } : {}),
    ...(['gate', 'browser'].includes(name) && shortSlot === 0 ? { slot: 'gate' } : {}),
    ...(['gate', 'browser'].includes(name) && shortEligible === 1 ? { requestedSlot: 'short-eligible' } : {}),
    ...(memoryHeld === 1 ? { memoryHeld: true } : {}), ...(timing === 1 ? { timing: true } : {}), ...(browser === 1 ? { browser: true } : {}), ...(gui === 1 ? { gui: true } : {}), ...(remote === 1 ? { remote: true } : {}),
    ...(runnerOnly === 1 ? { runnerOnly: true } : {}), ...(runner ? { runner } : {}), ...(item ? { item } : {}), ...(kind ? { kind } : {}), ...(leaseUntil ? { leaseUntil } : {}) });
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
    .map(({ ticket, pid, classed, release_aware, board_key, release_rank, queue_ticket, ...entry }) => {
      const current = queueClass(entry, now, ageMs);
      return { ...project(entry), queueClass: current.name, ...(current.effective < current.base ? { agedFrom: current.declared } : {}) };
    });
  // With reviews first on, an older pullboard in the line means everyone admits in arrival order until it leaves.
  return { holders, line, ...((order.reviewsFirst || order.currentReleaseFirst) && !classOrderInEffect(queued, order) && queued.some((waiter) => waiter.release_aware !== 1 || (!order.currentReleaseFirst && waiter.classed !== 1)) ? { order: 'arrival' } : {}) };
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
    return { host: runner.host, slots: runner.slots, browser: runner.browser, ...(runner.gui !== undefined ? { gui: runner.gui } : {}),
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
function gateAdmission(db, ticket, capacity, shortCapacity, runners, runnersFirst = false, order = ARRIVAL_ORDER, now = Date.now(), memoryHeld = false) {
  const waiters = orderedWaiters(queuedWaiters(db, 'gate'), now, order);
  const holders = db.prepare("SELECT pid, landing, browser, short_slot AS shortSlot, timing FROM holder WHERE name = 'gate'").all();
  const localUsed = holders.filter(holder => holder.shortSlot !== 1).length;
  const localShortUsed = holders.filter(holder => holder.shortSlot === 1).length;
  const localBrowsers = holders.filter(holder => holder.browser === 1).length;
  const browserCapacity = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get()?.capacity ?? 1;
  const usage = new Map(runners.map(runner => {
    // The reserved namespace is authoritative even for an older generic holder that
    // predates the name guard and has no runner column value.
    const remoteHolders = db.prepare('SELECT browser, timing FROM holder WHERE name = ?').all(runnerResourceName(runner.host));
    return [runner.host, {
      slots: remoteHolders.length,
      timing: remoteHolders.some(holder => holder.timing === 1),
      browsers: remoteHolders.filter(holder => holder.browser === 1).length,
    }];
  }));
  const unavailable = unavailableRunnerHosts(db, now);
  /** Keep an already holding process from taking another slot ahead of a different landing. */
  const blockedByLanding = waiter => holders.some(holder => holder.pid === waiter.pid)
    && waiters.some(other => other.landing === 1 && other.pid !== waiter.pid);
  /** Find a currently free compatible slot without reserving it for later queue entries. */
  function available(waiter) {
    if (blockedByLanding(waiter)) return null;
    /** Pick an eligible runner in durable round-robin order when the machine opts in. */
    function runnerSlot() {
      if (waiter.remote !== 1) return null;
      const cursor = runnersFirst ? db.prepare("SELECT next_host FROM runner_rotation WHERE pool = 'gate'").get()?.next_host : '';
      const start = Math.max(0, runners.findIndex(runner => runner.host === cursor));
      const ordered = runnersFirst ? [...runners.slice(start), ...runners.slice(0, start)] : runners;
      const compatible = ordered.filter(runner => {
        if (!runnerCompatible(db, runner, waiter, unavailable)) return false;
        const used = usage.get(runner.host);
        return !used.timing && (waiter.timing !== 1 || used.slots === 0)
          && used.slots < runner.slots && (waiter.browser !== 1 || used.browsers < runner.browser);
      });
      // Existing landing balancing stays intact when the opt-in rotation is off.
      if (!runnersFirst && waiter.landing === 1) compatible.sort((left, right) => usage.get(left.host).slots - usage.get(right.host).slots);
      if (!compatible.length) return null;
      const selected = compatible[0];
      const observed = db.prepare('SELECT gui FROM runner_gui WHERE host = ?').get(selected.host);
      return { ...selected, ...(observed ? { gui: observed.gui === null ? null : observed.gui === 1 } : {}), shortSlot: false };
    }
    /** The local slot follows runner admission only while runner-first is enabled. */
    function localSlot() {
      if (memoryHeld) return null;
      if (!holders.some(holder => holder.timing === 1) && (waiter.timing !== 1 || holders.length === 0)
        && localUsed < capacity && (waiter.browser !== 1 || localBrowsers < browserCapacity)) {
        return { host: '', slots: capacity, browser: waiter.browser === 1 ? 1 : 0, shortSlot: false };
      }
      return null;
    }
    const remote = runnerSlot();
    if (waiter.runnerOnly === 1 && runners.length) return remote;
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
    if (!memoryHeld && waiter.timing !== 1 && !holders.some(holder => holder.timing === 1)
      && waiter.shortEligible === 1 && !earlierLanding && localShortUsed < shortCapacity
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
  for (const waiter of waiters) {
    const executor = available(waiter);
    if (executor) {
      if (waiter.ticket !== ticket) return null;
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

/** A transport drop expires after the retry window; cleanup failures and unreadable timestamps stay blocked. */
function runnerUnavailable(entry, now) {
  return Boolean(entry && (entry.detail !== 'TRANSPORT_LOST' || !(now - Date.parse(entry.since) >= RUNNER_RETRY_MS)));
}

/** Use the same current transport and draining exclusions for admission and local-memory status. */
function unavailableRunnerHosts(db, now) {
  return new Set([
    ...db.prepare('SELECT host, since, detail FROM runner_unavailable').all()
      .filter(row => runnerUnavailable(row, now)).map(row => row.host),
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
        const recorded = db.prepare('SELECT since, detail FROM runner_unavailable WHERE host = ?').get(runner.host);
        const unavailable = runnerUnavailable(recorded, Date.now()) ? recorded : null;
        const observed = db.prepare('SELECT gui, observed_at FROM runner_gui WHERE host = ?').get(runner.host);
        return [{ ...runner, gui: runner.gui ?? null, ...(observed ? { gui: observed.gui === null ? null : observed.gui === 1, guiObservedAt: observed.observed_at } : {}), inUse: holders.length, browserInUse: holders.filter(holder => holder.browser === 1).length,
          unavailable: Boolean(unavailable), ...(unavailable ? { unavailableSince: unavailable.since, unavailableReason: unavailable.detail } : {}), holders }];
      });
    });
  } finally { db.close(); }
}

/** Persist only an authenticated worker's fresh GUI observation; unknown replaces stale positive capability. */
export function recordRunnerGui(host, gui) {
  if (typeof host !== 'string' || !host.trim() || ![true, false, null].includes(gui)) throw new Refused('BAD_RUNNER_POOL', 'runner GUI observations require a host and true, false, or unknown');
  const db = open(machineResourceFile());
  try { update(db, () => db.prepare('INSERT INTO runner_gui(host, gui, observed_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET gui = excluded.gui, observed_at = excluded.observed_at')
    .run(host, gui === null ? null : Number(gui), new Date().toISOString())); }
  finally { db.close(); }
}

/** Serialize runner changes with admission; removal may drain active leases instead of refusing. */
export function updateRunnerSettings(host, persist, { drain = false } = {}) {
  if (typeof host !== 'string' || !host.trim() || host.trim() !== host || typeof persist !== 'function') {
    throw new Refused('BAD_RUNNER_SETTINGS', 'a runner host and settings persistence callback are required');
  }
  const db = open(machineResourceFile());
  try {
    return update(db, () => {
      const resourceName = runnerResourceName(host);
      const held = db.prepare('SELECT COUNT(*) AS count FROM holder WHERE name = ?').get(resourceName).count;
      if (held && !drain) throw new Refused('RUNNER_BUSY', `runner ${host} has ${held} active slot(s); wait for them to finish before changing its settings`);
      const draining = drain && held && db.prepare('SELECT runner FROM runner_draining WHERE host = ?').get(host);
      if (draining) return { ...JSON.parse(draining.runner), draining: true };
      const result = persist();
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
      db.prepare('DELETE FROM runner_unavailable WHERE host = ?').run(host);
      db.prepare('DELETE FROM runner_draining WHERE host = ?').run(host);
      return result;
    });
  } finally { db.close(); }
}

const MEMORY_CACHE_MS = 2_000;
/** How long a runner whose transport dropped sits out before the pool tries it again. */
const RUNNER_RETRY_MS = 5 * 60_000;
const MEMORY_COMMAND_TIMEOUT_MS = 2_000;
const LINUX_CRITICAL_FULL_AVG10 = 10;
const LINUX_WARN_SOME_AVG10 = 10;
const memoryCache = new Map();

/** Run a small OS utility asynchronously; a slow or missing tool rejects instead of blocking a run. */
function readCommand(file, args) {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(file, args, { encoding: 'utf8', timeout: MEMORY_COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout) => (error ? rejectOutput(error) : resolveOutput(stdout)));
  });
}

/** Read macOS pressure level, free percentage and size from one sysctl call. */
async function readDarwinMemory(run) {
  const [level, freePercent, total] = (await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', 'hw.memsize'])).trim().split(/\s+/u).map(Number);
  if (![level, freePercent, total].every(Number.isFinite) || total <= 0) throw new Error('sysctl did not report memory pressure');
  // The kernel's levels are 1 normal, 2 warn and 4 critical; the free percentage is the one Activity Monitor uses.
  const pressure = level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal';
  return { pressure, availableBytes: Math.round(total * freePercent / 100), totalBytes: total };
}

/** Read Linux MemAvailable and, where the kernel has it, pressure stall information. */
async function readLinuxMemory(readText) {
  const meminfo = await readText('/proc/meminfo');
  const field = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'mu').exec(meminfo)?.[1]) * 1024;
  const availableBytes = field('MemAvailable');
  const totalBytes = field('MemTotal');
  if (!Number.isFinite(availableBytes) || !Number.isFinite(totalBytes)) throw new Error('/proc/meminfo has no MemAvailable');
  let pressure = 'unknown';
  try {
    const psi = await readText('/proc/pressure/memory');
    const avg10 = (kind) => Number(new RegExp(`^${kind} avg10=([\\d.]+)`, 'mu').exec(psi)?.[1]);
    const full = avg10('full');
    const some = avg10('some');
    if (Number.isFinite(full) || Number.isFinite(some)) {
      pressure = full >= LINUX_CRITICAL_FULL_AVG10 ? 'critical' : some >= LINUX_WARN_SOME_AVG10 ? 'warn' : 'normal';
    }
  } catch { /* Kernels without PSI still report MemAvailable, which the floor checks. */ }
  return { pressure, availableBytes, totalBytes };
}

/** Name the biggest processes by resident memory, with their working directories where the OS allows. */
async function readBiggestProcesses(platform, run, readLink, count = 3) {
  const listed = (await run('/bin/ps', ['-e', '-o', 'pid=', '-o', 'rss=', '-o', 'comm='])).split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    // Only the executable's own name is kept: arguments can carry secrets.
    return match ? { pid: Number(match[1]), bytes: Number(match[2]) * 1024, name: basename(match[3].trim()) } : null;
  }).filter(Boolean).sort((left, right) => right.bytes - left.bytes).slice(0, count);
  return Promise.all(listed.map(async (entry) => {
    let cwd = '', cwdFailure = '';
    try {
      if (platform === 'linux') cwd = await readLink(`/proc/${entry.pid}/cwd`);
      else cwd = /^n(.*)$/mu.exec(await run('/usr/sbin/lsof', ['-b', '-a', '-d', 'cwd', '-p', String(entry.pid), '-Fn']))?.[1] ?? '';
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'unavailable';
      cwdFailure = `an unreadable directory for pid ${entry.pid} (${platform === 'linux' ? 'readlink' : 'lsof'} ${code})`;
    }
    if (!cwd && !cwdFailure) cwdFailure = `an unreadable directory for pid ${entry.pid} (no directory reported)`;
    return { ...entry, cwd, ...(cwdFailure ? { cwdFailure } : {}) };
  }));
}

/**
 * Take one reading of the machine's memory: pressure, free bytes and, when asked, the biggest
 * processes. A platform or tool that cannot answer returns checked: false rather than throwing,
 * so the pool falls back to counting slots.
 *
 * @param {{ platform?: string, processes?: boolean, run?: (file: string, args: string[]) => Promise<string>, readText?: (file: string) => Promise<string>, readLink?: (file: string) => Promise<string> }} [options]
 * @returns {Promise<{ checked: true, pressure: string, availableBytes: number, totalBytes: number, processes?: object[] } | { checked: false, platform: string, reason: string }>}
 */
export async function readMachineMemory({ platform = process.platform, processes = false, run = readCommand, readText = (file) => readFile(file, 'utf8'), readLink = readlink } = {}) {
  try {
    let reading;
    if (platform === 'darwin') reading = await readDarwinMemory(run);
    else if (platform === 'linux') reading = await readLinuxMemory(readText);
    else return { checked: false, platform, reason: 'no memory reader for this platform' };
    if (!processes) return { checked: true, ...reading };
    let biggest = [];
    try { biggest = await readBiggestProcesses(platform, run, readLink); } catch { /* The hold still stands without names. */ }
    return { checked: true, ...reading, processes: biggest };
  } catch (error) {
    return { checked: false, platform, reason: String(error?.message ?? error).split('\n')[0] };
  }
}

/** Format a byte count the way a person reads memory: MB under a gigabyte, GB above. */
function memorySize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Decide whether a reading holds the queue and say so in one line. The same line serves a held
 * run and pullboard resources, so a person sees one description of the machine.
 *
 * @param {object} reading - A readMachineMemory result.
 * @param {number|null} floorBytes - Free memory under which the queue is held; null when the hold is off.
 * @returns {{ checked: boolean, held: boolean, line: string, warning?: string }}
 */
export function memoryVerdict(reading, floorBytes) {
  if (!reading?.checked) {
    const warning = `memory: not checked on ${reading?.platform ?? process.platform} (${reading?.reason ?? 'no reading'}); the gate pool admits by slots alone`;
    return { checked: false, held: false, line: warning, warning };
  }
  const off = floorBytes === null;
  const critical = !off && reading.pressure === 'critical';
  const low = !off && reading.availableBytes < floorBytes;
  const held = critical || low;
  const why = [critical ? 'pressure is critical' : '', low ? 'free memory is under the floor' : ''].filter(Boolean).join(' and ');
  const pressure = reading.pressure === 'unknown' ? 'pressure not reported' : `pressure ${reading.pressure}`;
  const state = `${pressure}, ${memorySize(reading.availableBytes)} free of ${memorySize(reading.totalBytes)}${off ? '' : ` (floor ${memorySize(floorBytes)})`}`;
  const biggest = (reading.processes ?? []).map(({ pid, name, bytes, cwd, cwdFailure }) => `pid ${pid} ${name} ${memorySize(bytes)} in ${cwd || cwdFailure || 'an unreadable directory'}`).join('; ');
  const verdict = off ? 'hold off (set gate.memoryFloorMB to turn it on)' : held ? `holding local gate runs because ${why}` : 'admitting';
  return { checked: true, held, line: `memory: ${verdict}: ${state}${biggest ? `; biggest: ${biggest}` : ''}` };
}

/**
 * Build the gate pool's memory check: a cached reading, then the biggest processes only while the
 * queue is held, so polling stays at one cheap call every couple of seconds.
 *
 * @param {{ floorBytes: () => number, read?: typeof readMachineMemory, cacheMs?: number }} options
 * @returns {() => Promise<{ checked: boolean, held: boolean, line: string, warning?: string }>}
 */
export function memoryAdmission({ floorBytes, read = readMachineMemory, cacheMs = MEMORY_CACHE_MS }) {
  return async () => {
    const cached = memoryCache.get(read);
    if (cached && Date.now() - cached.at < cacheMs) return cached.verdict;
    const floor = floorBytes();
    let verdict = memoryVerdict(await read({ processes: false }), floor);
    if (verdict.held) verdict = memoryVerdict(await read({ processes: true }), floor);
    memoryCache.set(read, { at: Date.now(), verdict });
    return verdict;
  };
}

/** Pause briefly between durable queue checks. */
function pause(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/**
 * Join the queue in its admission class (landing, review, submit, other), aging up over time; FIFO by ticket within a class.
 *
 * @param {{ name: string, capacity: number, capacityProvider?: () => number, shortCapacityProvider?: () => number, browserCapacityProvider?: () => number, scope?: 'machine'|'repo'|'board', root?: string, agent?: string, repo?: string, landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, remote?: boolean, runnerOnly?: boolean, runnerExecution?: boolean, timing?: boolean, runnerProvider?: () => Array<{host:string,slots:number,browser:number}>, item?: string, kind?: string, onWait?: (state: object) => any | Promise<any>, allowIdleCapacityUpdate?: boolean, memory?: () => Promise<{ checked: boolean, held: boolean, line: string, warning?: string }>, _resume?: object }} options - Resource identity, queue class, short-slot eligibility, optional remote executor pool and memory check. An awaited wait callback may return {leaseUntil} and then receives a final {admitted:true} callback before work starts.
 *   memory, when given, is read before each admission: a held verdict blocks ordinary and short local
 *   executors while compatible remote slots remain eligible; an unchecked one is passed to onWait once
 *   so the caller can warn.
 * @returns {Promise<{ name: string, scope: string, token: string, pool: string, browser: boolean, slotClass: 'gate'|'short', runner?: {host:string,slots:number,browser:number}, waitMs: number, release: () => void, renew: () => void, requeueRunner?: (reason?: string, options?: { local?: boolean }) => Promise<object> }>}
 */
export async function takeResource(options) {
  const { name, capacity, scope = 'machine', root = process.cwd(), allowIdleCapacityUpdate = false } = options;
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
  let pool;
  try { pool = canonicalResourceFile(file); }
  catch (error) { db.close(); throw error; }
  const awarenessCursor = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM timing_client_observation').get().id;
  const unfenced = new Map();
  /** Preserve every observed unfenced client throughout this admission and execution. */
  const timingEvidence = () => {
    if (!timing) return { exclusive: false, unfencedClients: [] };
    const observations = db.prepare(`SELECT agent,pid,started FROM timing_client_observation WHERE id > ?
      UNION SELECT agent,pid,started FROM holder WHERE name = 'gate' AND timing_aware = 0
      UNION SELECT agent,pid,started FROM waiter WHERE name = 'gate' AND timing_aware = 0`).all(awarenessCursor);
    for (const client of observations) unfenced.set(`${client.pid}:${client.started}:${client.agent}`, { ...client });
    return { exclusive: unfenced.size === 0, unfencedClients: [...unfenced.values()] };
  };
  timingEvidence();
  const resume = options._resume;
  const token = resume?.token ?? randomUUID();
  const requestedAt = resume?.requestedAt ?? Date.now();
  let priorWaitMs = resume?.priorWaitMs ?? 0;
  let waitStartedAt = resume?.waitStartedAt ?? Date.now();
  const pid = process.pid;
  const agent = options.agent ?? process.env.PULLBOARD_AGENT ?? `pid-${pid}`;
  const started = processStarted(pid);
  const repo = options.repo ?? repoRoot(root);
  let queuedAt = resume?.queuedAt ?? new Date().toISOString();
  let leaseUntil = '';
  /** Record an item's lease only after its awaited owner renewal succeeds. */
  const keepItemLease = async (state, table) => {
    const result = await options.onWait?.(state);
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
    let initialTicket = resume?.ticket;
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
        if (!allowIdleCapacityUpdate || activeHolders || state.line.length) {
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
          if (!allowIdleCapacityUpdate || state.holders.length || state.line.length) {
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
      const order = queueOrder(scope);
      const acquired = await retryLockedSlotDatabase(file, () => update(db, () => {
        const now = Date.now();
        // The machine-settings provider performs a bounded local JSON read. Read it
        // after taking the same SQLite write lock used by updateRunnerSettings so an
        // older pre-lock snapshot cannot overwrite a newer configured capacity.
        const runners = runnerProvider ? validatedRunners(runnerProvider()) : [];
        const runnersFirst = runnersFirstProvider?.() === true;
        const waiter = db.prepare('SELECT ticket, remote, browser, gui FROM waiter WHERE token = ?').get(token);
        if (!waiter) {
          if (resume && initialTicket) {
            db.prepare('INSERT OR IGNORE INTO waiter(ticket, token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible, gui, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(initialTicket, token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote), classedMarker(order), 1, boardKey, releaseRank, resume?.queueTicket ?? null, Number(shortEligible), Number(gui), Number(timing), 1);
            return { acquired: false, state: { ...snapshot(db, name, order), position: waiterPosition(db, name, initialTicket, { order, shortCapacity: options.shortCapacityProvider?.() ?? 0 }), rejoined: true } };
          }
          queuedAt = new Date().toISOString();
          const rejoined = db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, remote, classed, release_aware, board_key, release_rank, queue_ticket, short_eligible, gui, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, Number(remote), classedMarker(order), 1, boardKey, releaseRank, resume?.queueTicket ?? null, Number(shortEligible), Number(gui), Number(timing), 1);
          initialTicket = Number(rejoined.lastInsertRowid);
          return { acquired: false, state: { ...snapshot(db, name, order), position: waiterPosition(db, name, initialTicket, { order, shortCapacity: options.shortCapacityProvider?.() ?? 0 }), rejoined: true } };
        }
        // The marker follows this poll's setting, so a change mid-wait reaches every process's ranking.
        db.prepare('UPDATE waiter SET heartbeat = ?, classed = ?, runner_only = ? WHERE token = ?').run(Date.now(), classedMarker(order), Number(runnerOnly), token);
        const unavailable = unavailableRunnerHosts(db, now);
        const memoryHeld = Boolean(memory?.held && (name !== 'gate' || waiter.remote !== 1
          || !runners.some(runner => runnerCompatible(db, runner, waiter, unavailable))));
        db.prepare('UPDATE waiter SET memory_held = ? WHERE token = ?').run(Number(memoryHeld), token);
        const spot = snapshot(db, name, order, now);
        const reportPosition = waiterPosition(db, name, waiter.ticket, { order, now, shortCapacity: options.shortCapacityProvider?.() ?? 0 });
        const limit = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name).capacity;
        // Local pressure blocks local executors, including short slots, but never a remote executor.
        if (name !== 'gate' && memoryHeld) return { acquired: false, state: { ...spot, position: reportPosition, memory } };
        const executor = name === 'gate'
          ? gateAdmission(db, waiter.ticket, limit, options.shortCapacityProvider?.() ?? 0, runners, runnersFirst, order, now, memory?.held === true)
          : (waiterPosition(db, name, waiter.ticket, { eligibleOnly: true, order, now }) === 1 && spot.holders.length < limit ? { host: '' } : null);
        if (executor) {
          const queueTicket = consumeOpportunity(db, name, waiter.ticket, order, now);
          db.prepare('DELETE FROM waiter WHERE token = ?').run(token);
          const acquiredAt = new Date().toISOString();
          const holderName = executor.host ? runnerResourceName(executor.host) : name;
          db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind, runner, short_slot, timing, timing_aware) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, holderName, pid, started, agent, repo, acquiredAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind, executor.host, Number(executor.shortSlot === true), Number(timing), 1);
          db.prepare('UPDATE holder SET runner_execution = ? WHERE token = ?').run(Number(options.runnerExecution === true), token);
          return { acquired: true, state: { ...spot, position: 0 }, ticket: waiter.ticket, queueTicket, runner: executor.host ? executor : undefined, shortSlot: executor.shortSlot === true, capacity: limit, admittedAt: acquiredAt };
        }
        return { acquired: false, state: { ...spot, position: reportPosition, ...(memoryHeld ? { memory } : {}) } };
      }));
      if (acquired.acquired) {
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
        let released = false;
        let transferred = false;
        let lost = false;
        let heartbeat;
        /** Keep the active holder lease alive while its executor is running. */
        const startHeartbeat = () => {
          heartbeat = setInterval(() => {
            if (released || transferred || lost) return;
            try {
              const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
              if (!changed) { lost = true; clearInterval(heartbeat); }
            } catch { /* Lease expiry remains the crash fallback. */ }
          }, HEARTBEAT_MS);
          heartbeat.unref();
        };
        startHeartbeat();
        /** Commit this holder's deletion before closing; a failed update remains live and retryable. */
        const release = () => {
          if (released || transferred) return;
          update(db, () => {
            db.prepare('DELETE FROM holder WHERE token = ?').run(token);
            removeEmptyViewPortResource(db, name);
          });
          released = true;
          clearInterval(heartbeat);
          db.close();
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
        const requeueRunner = async (reason = 'transport-lost', { local = false } = {}) => {
          if (!acquired.runner) throw new Refused('LOCAL_RUNNER_REQUEUE', 'only a remote lease can be returned to the runner queue');
          if (released || transferred || lost) throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          transferred = true;
          clearInterval(heartbeat);
          let requeueTicket = acquired.ticket;
          let requeueOpportunity = acquired.queueTicket;
          try {
            update(db, () => {
              db.prepare('INSERT INTO runner_unavailable(host, since, detail) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET since = excluded.since, detail = excluded.detail')
                .run(acquired.runner.host, new Date().toISOString(), reason === 'cleanup-unverified' ? 'CLEANUP_UNVERIFIED' : 'TRANSPORT_LOST');
              const holderName = runnerResourceName(acquired.runner.host);
              const holder = db.prepare('SELECT token FROM holder WHERE token = ? AND name = ? AND runner = ?').get(token, holderName, acquired.runner.host);
              if (!holder) throw new Refused('RESOURCE_LEASE_LOST', `remote lease for "${name}" is no longer held`);
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
            });
          } catch (error) {
            transferred = false;
            startHeartbeat();
            throw error;
          }
          db.close();
          return takeResource({ ...options, ...(local && !runnerOnly ? { remote: false } : {}), _resume: { token, ticket: requeueTicket ?? acquired.ticket, queueTicket: requeueOpportunity,
            queuedAt, requestedAt, priorWaitMs: acquiredWaitMs, waitStartedAt: Date.now() } });
        };
        return { name, scope, token, pool, browser, timing, runnerExecution: options.runnerExecution === true, admittedAt: acquired.admittedAt, capacity: acquired.capacity, slotClass: acquired.shortSlot ? 'short' : 'gate', ...(acquired.runner ? { runner: acquired.runner } : {}),
          waitMs: acquiredWaitMs, release, renew, timingEvidence,
          ...(acquired.runner ? { requeueRunner } : {}) };
      }
      await keepItemLease(acquired.state, 'waiter');
      await pause(POLL_MS);
    }
  } catch (error) {
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

/** Raise live capacity atomically; a decrease waits for an empty queue without evicting holders. */
export function setResourceCapacity({ name, capacity, scope = 'machine', root = process.cwd(), allowZero = false, persist = () => {} }) {
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (name.startsWith('runner:')) throw new Refused('RESERVED_RUNNER_RESOURCE', 'runner resource rows are managed by the machine gate; use runner settings');
  if (!Number.isSafeInteger(capacity) || capacity < (allowZero && scope === 'machine' && ['gate', 'browser'].includes(name) ? 0 : 1)) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  const db = open(databaseFile(scope, root), scope === 'machine');
  try {
    return update(db, () => {
      const state = snapshot(db, name);
      const current = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name)?.capacity;
      if ((state.holders.length || state.line.length) && (current === undefined || capacity < current)) {
        const holders = state.holders.map(holder => `${holder.agent} (${holder.repo})`).join(', ') || 'none';
        throw new Refused('RESOURCE_BUSY', `resource "${name}" has ${state.holders.length} holder(s) and ${state.line.length} waiter(s); running: ${holders}; wait for it to become idle, then retry pullboard settings ${name === 'browser' ? 'browserSlots' : 'gateSlots'} ${capacity}`);
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
