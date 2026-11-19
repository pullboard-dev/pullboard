/** Test-only frozen resource API from baseline 3762af1caf428ac818a49d4b78345648ee89dbfc; only relative production imports are redirected. */
/** Machine and repository queues persist leases; landings go first, then eligible waiters in arrival order [Q1,Q2,Q3]. */
import {
  mkdirSync,
  realpathSync,
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
import { repoInfo } from '../../../../git/index.js';
import { machineHome } from '../../../../resources/index.js';
import { Refused } from '../../../../kernel/light.js';

const LEASE_MS = 20_000;
const HEARTBEAT_MS = 3_000;
const POLL_MS = 40;
const PROCESS_IDENTITY_CACHE_MS = 3_000;
const processIdentities = new Map();

/** Mark child commands whose parent already owns a machine gate slot. */
export const GATE_SLOT_HELD_ENV = 'PULLBOARD_GATE_SLOT_HELD';
export const GATE_SLOT_POOL_ENV = 'PULLBOARD_GATE_SLOT_POOL';
export const GATE_SLOT_TOKEN_ENV = 'PULLBOARD_GATE_SLOT_TOKEN';
export const BROWSER_SLOT_HELD_ENV = 'PULLBOARD_BROWSER_SLOT_HELD';

/** Build child markers that identify the exact machine queue lease and its browser capacity. */
export function gateSlotEnvironment(lease) {
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
function open(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000');
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    db.exec(`CREATE TABLE IF NOT EXISTS resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS holder_name ON holder(name);
      CREATE TABLE IF NOT EXISTS waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL, landing INTEGER NOT NULL DEFAULT 0, item_check INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS waiter_name_ticket ON waiter(name, ticket);`);
    for (const table of ['holder', 'waiter']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (!columns.includes('started')) db.exec(`ALTER TABLE ${table} ADD COLUMN started TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('landing')) db.exec(`ALTER TABLE ${table} ADD COLUMN landing INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('item_check')) db.exec(`ALTER TABLE ${table} ADD COLUMN item_check INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('diagnostic')) db.exec(`ALTER TABLE ${table} ADD COLUMN diagnostic INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('browser')) db.exec(`ALTER TABLE ${table} ADD COLUMN browser INTEGER NOT NULL DEFAULT 0`);
      if (!columns.includes('item')) db.exec(`ALTER TABLE ${table} ADD COLUMN item TEXT NOT NULL DEFAULT ''`);
      if (!columns.includes('kind')) db.exec(`ALTER TABLE ${table} ADD COLUMN kind TEXT NOT NULL DEFAULT ''`);
    }
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

/** Current holders and the landing-first line, then every other kind in arrival order. */
function snapshot(db, name) {
  /** Preserve older public entries while naming diagnostics as a distinct queue class. */
  const project = ({ diagnostic, browser, item, kind, ...entry }) => ({ ...entry, landing: entry.landing === 1,
    itemCheck: entry.itemCheck === 1 && diagnostic !== 1, ...(diagnostic === 1 ? { diagnostic: true } : {}),
    ...(browser === 1 ? { browser: true } : {}), ...(item ? { item } : {}), ...(kind ? { kind } : {}) });
  // Browser is an additional capability on a gate lease, not a second partially held row.
  const where = name === 'browser' ? 'name = ? AND browser = 1' : 'name = ?';
  const sourceName = name === 'browser' ? 'gate' : name;
  const holders = db.prepare(`SELECT agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, item, kind FROM holder WHERE ${where} ORDER BY since, token`).all(sourceName).map(project);
  const line = db.prepare(`SELECT agent, repo, since, landing, item_check AS itemCheck, diagnostic, browser, item, kind FROM waiter WHERE ${where} ORDER BY landing DESC, ticket`).all(sourceName).map(project);
  return { holders, line };
}

/** Count reported or admissible queue position separately so blocked work cannot distort the visible line. */
function waiterPosition(db, name, ticket, { eligibleOnly = false } = {}) {
  const queueName = name === 'browser' ? 'gate' : name;
  const waiters = db.prepare('SELECT ticket, pid, agent, repo, landing, item_check AS itemCheck, browser FROM waiter WHERE name = ? ORDER BY ticket').all(queueName);
  const holders = db.prepare('SELECT pid, agent, repo FROM holder WHERE name = ?').all(queueName);
  const browserBusy = db.prepare("SELECT COUNT(*) AS count FROM holder WHERE name = 'gate' AND browser = 1").get().count > 0;
  /** A live process owns its leases even if it changes descriptive agent or repository labels. */
  const holdsSlot = (waiter) => holders.some((holder) => holder.pid === waiter.pid);
  /** Leave a waiting independent landing a slot before a holder takes another lease. */
  const blockedByLanding = (waiter) => holdsSlot(waiter)
    && waiters.some((other) => other.landing === 1 && other.pid !== waiter.pid);
  /** Map queue entries to their declared precedence class. */
  const rank = (waiter) => waiter.landing === 1 ? 0 : 1;
  const line = name === 'browser' ? waiters.filter((waiter) => waiter.browser === 1) : waiters;
  const considered = line.filter((waiter) => !blockedByLanding(waiter)
    // Browser availability affects admission only; reported positions retain every browser waiter.
    && (!eligibleOnly || name === 'browser' || waiter.browser !== 1 || !browserBusy));
  const current = line.find((waiter) => waiter.ticket === ticket);
  if (!current) return eligibleOnly ? Number.MAX_SAFE_INTEGER : line.length + 1;
  const currentIndex = considered.findIndex((waiter) => waiter.ticket === ticket);
  if (currentIndex < 0) return eligibleOnly ? Number.MAX_SAFE_INTEGER : Math.max(2, considered.length + 1);
  const currentRank = rank(current);
  return considered.filter((waiter) => rank(waiter) < currentRank || (rank(waiter) === currentRank && waiter.ticket <= ticket)).length;
}

/** Pause briefly between durable queue checks. */
function pause(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/**
 * Join the landing-first queue; every other kind keeps its original FIFO ticket.
 *
 * @param {{ name: string, capacity: number, capacityProvider?: () => number, scope?: 'machine'|'repo'|'board', root?: string, agent?: string, repo?: string, landing?: boolean, itemCheck?: boolean, diagnostic?: boolean, browser?: boolean, item?: string, kind?: string, onWait?: (state: object) => void, allowIdleCapacityUpdate?: boolean }} options - Resource identity and queue class.
 * @returns {Promise<{ name: string, scope: string, token: string, pool: string, browser: boolean, waitMs: number, release: () => void, renew: () => void }>}
 */
export async function takeResource(options) {
  const { name, capacity, scope = 'machine', root = process.cwd(), allowIdleCapacityUpdate = false } = options;
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  const landing = options.landing === true;
  const itemCheck = options.itemCheck === true;
  const diagnostic = options.diagnostic === true;
  const browser = options.browser === true;
  const item = options.item ?? '';
  const kind = options.kind ?? '';
  if (browser && name !== 'gate') throw new Refused('BAD_BROWSER_RESOURCE', 'browser capacity can only be acquired together with the machine gate; request name "gate" with browser: true');
  if (name === 'browser' && !browser) throw new Refused('BAD_BROWSER_RESOURCE', 'browser capacity is acquired only as part of a gate lease; request name "gate" with browser: true');
  if (typeof item !== 'string' || typeof kind !== 'string') throw new Refused('BAD_RESOURCE_METADATA', 'resource item and kind metadata must be text');
  if (landing && itemCheck) throw new Refused('BAD_RESOURCE_PRIORITY', 'a gate slot cannot be both a landing and an item check');
  if (diagnostic && (landing || itemCheck)) throw new Refused('BAD_RESOURCE_PRIORITY', 'a diagnostic slot cannot also be a landing or an item check');
  const file = databaseFile(scope, root);
  const db = open(file);
  let pool;
  try { pool = canonicalResourceFile(file); }
  catch (error) { db.close(); throw error; }
  const token = randomUUID();
  const requestedAt = Date.now();
  const pid = process.pid;
  const agent = options.agent ?? process.env.PULLBOARD_AGENT ?? `pid-${pid}`;
  const started = processStarted(pid);
  const repo = options.repo ?? repoRoot(root);
  let queuedAt = new Date().toISOString();
  try {
    update(db, () => {
      const currentCapacity = options.capacityProvider?.() ?? capacity;
      if (!Number.isSafeInteger(currentCapacity) || currentCapacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
      const row = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name);
      if (row && row.capacity !== currentCapacity) {
        const state = snapshot(db, name);
        if (!allowIdleCapacityUpdate || state.holders.length || state.line.length) {
          throw new Refused('RESOURCE_CAPACITY_MISMATCH', `resource "${name}" already has capacity ${row.capacity}`);
        }
        db.prepare('UPDATE resource SET capacity = ? WHERE name = ?').run(currentCapacity, name);
      }
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, currentCapacity);
      if (browser) {
        const browserResource = db.prepare("SELECT capacity FROM resource WHERE name = 'browser'").get();
        if (browserResource && browserResource.capacity !== 1) throw new Refused('RESOURCE_CAPACITY_MISMATCH', 'resource "browser" has fixed capacity 1');
        db.prepare("INSERT INTO resource(name, capacity) VALUES ('browser', 1) ON CONFLICT(name) DO NOTHING").run();
      }
      // Retain queue metadata for older readers; admission uses landing priority and arrival only.
      db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind);
    });
    while (true) {
      const acquired = update(db, () => {
        const waiter = db.prepare('SELECT ticket FROM waiter WHERE token = ?').get(token);
        if (!waiter) {
          queuedAt = new Date().toISOString();
          const rejoined = db.prepare('INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, started, agent, repo, queuedAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind);
          return { acquired: false, state: { ...snapshot(db, name), position: waiterPosition(db, name, Number(rejoined.lastInsertRowid)), rejoined: true } };
        }
        db.prepare('UPDATE waiter SET heartbeat = ? WHERE token = ?').run(Date.now(), token);
        const spot = snapshot(db, name);
        const reportPosition = waiterPosition(db, name, waiter.ticket);
        const admissionPosition = waiterPosition(db, name, waiter.ticket, { eligibleOnly: true });
        const limit = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name).capacity;
        const browserAdmissionPosition = browser ? waiterPosition(db, 'browser', waiter.ticket, { eligibleOnly: true }) : 0;
        const browserHolders = browser ? db.prepare("SELECT COUNT(*) AS count FROM holder WHERE name = 'gate' AND browser = 1").get().count : 0;
        if (admissionPosition === 1 && spot.holders.length < limit && (!browser || (browserAdmissionPosition === 1 && browserHolders < 1))) {
          db.prepare('DELETE FROM waiter WHERE token = ?').run(token);
          const acquiredAt = new Date().toISOString();
          db.prepare('INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat, landing, item_check, diagnostic, browser, item, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, started, agent, repo, acquiredAt, Date.now(), Number(landing), Number(itemCheck || diagnostic), Number(diagnostic), Number(browser), item, kind);
          return { acquired: true, state: { ...spot, position: 0 } };
        }
        return { acquired: false, state: { ...spot, position: reportPosition } };
      });
      if (acquired.acquired) {
        let released = false;
        let lost = false;
        const heartbeat = setInterval(() => {
          if (released || lost) return;
          try {
            const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
            if (!changed) { lost = true; clearInterval(heartbeat); }
          } catch { /* Lease expiry remains the crash fallback. */ }
        }, HEARTBEAT_MS);
        heartbeat.unref();
        /** Release the resource and close its SQLite handle. */
        const release = () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try { update(db, () => db.prepare('DELETE FROM holder WHERE token = ?').run(token)); }
          finally { db.close(); }
        };
        /** Refresh this lease, or refuse if another process already evicted it. */
        const renew = () => {
          if (released || lost) throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          const changed = update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token).changes);
          if (!changed) {
            lost = true;
            clearInterval(heartbeat);
            throw new Refused('RESOURCE_LEASE_LOST', `resource lease for "${name}" is no longer held`);
          }
        };
        return { name, scope, token, pool, browser, waitMs: Math.max(0, Date.now() - requestedAt), release, renew };
      }
      options.onWait?.(acquired.state);
      await pause(POLL_MS);
    }
  } catch (error) {
    try { update(db, () => db.prepare('DELETE FROM waiter WHERE token = ?').run(token)); } catch { /* Preserve the original error. */ }
    db.close();
    throw error;
  }
}

/** Reuse a same-machine gate lease in a child without queueing or acquiring a partial browser slot. */
export function inheritedGateSlot({ root = process.cwd(), browser = false } = {}) {
  const markedPool = process.env[GATE_SLOT_POOL_ENV] ?? '';
  const token = process.env[GATE_SLOT_TOKEN_ENV] ?? '';
  if (!markedPool && !token) return null;
  if (!markedPool) throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited gate token has no pool marker; start the child with gateSlotEnvironment(lease)');
  const pool = canonicalResourceFile(machineResourceFile());
  // A process with a different PULLBOARD_MACHINE_HOME is independent and must join its own queue.
  if (canonicalResourceFile(markedPool) !== pool) return null;
  if (process.env[GATE_SLOT_HELD_ENV] !== '1') throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited gate lease is missing its legacy held marker; start the child with gateSlotEnvironment(lease)');
  if (!token) throw new Refused('GATE_SLOT_TOKEN_REQUIRED', 'the inherited gate pool marker has no lease token; restart the child with gateSlotEnvironment(lease)');
  const db = open(pool);
  let holder;
  try {
    holder = update(db, () => db.prepare("SELECT browser FROM holder WHERE name = 'gate' AND token = ?").get(token));
  } finally { db.close(); }
  if (!holder) throw new Refused('GATE_SLOT_LEASE_LOST', 'the inherited gate lease is missing or expired; remove stale gate markers or let the parent reacquire the gate slot');
  const expectedBrowserMarker = holder.browser === 1 ? '1' : '';
  if (process.env[BROWSER_SLOT_HELD_ENV] !== expectedBrowserMarker) throw new Refused('GATE_SLOT_MARKER_INVALID', 'the inherited browser marker does not match its live gate lease; restart the child with gateSlotEnvironment(lease)');
  if (browser && holder.browser !== 1) throw new Refused('BROWSER_SLOT_REQUIRED', 'the inherited gate lease does not hold the browser slot; release it and reacquire gate with browser: true before launching Chrome');
  return {
    name: 'gate', scope: 'machine', token, pool, browser: holder.browser === 1, waitMs: 0,
    release() {}, renew() {},
  };
}

/** Change a resource's capacity only while its queue is empty, persisting related settings under the same lock. */
export function setResourceCapacity({ name, capacity, scope = 'machine', root = process.cwd(), persist = () => {} }) {
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  if (name === 'browser' && capacity !== 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'browser resource capacity is fixed at 1');
  const db = open(databaseFile(scope, root));
  try {
    return update(db, () => {
      const state = snapshot(db, name);
      if (state.holders.length || state.line.length) {
        throw new Refused('RESOURCE_BUSY', `resource "${name}" has ${state.holders.length} holder(s) and ${state.line.length} waiter(s); wait for it to become idle, then retry pullboard settings gateSlots ${capacity}`);
      }
      persist();
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET capacity = excluded.capacity').run(name, capacity);
      return { name, capacity };
    });
  } finally { db.close(); }
}

/** List resources and prune leases whose process died or lease expired. */
export function listResources({ scope = 'machine', root = process.cwd() } = {}) {
  const db = open(databaseFile(scope, root));
  try {
    return update(db, () => db.prepare('SELECT name, capacity FROM resource ORDER BY name').all().map(({ name, capacity }) => ({ name, capacity, ...snapshot(db, name) })));
  } finally { db.close(); }
}
