/** Local machine and repository resource queues with SQLite-backed leases [Q1,Q2,Q3]. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { repoInfo } from './git.js';
import { Refused } from './refused.js';

const LEASE_MS = 20_000;
const HEARTBEAT_MS = 3_000;
const POLL_MS = 40;

/** Resolve the local database for the requested scope. */
function databaseFile(scope, root) {
  if (scope === 'board') throw new Refused('BOARD_SCOPE_UNAVAILABLE', 'board-scoped resources need the relay; run pullboard relay on');
  if (scope === 'machine') return join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'resources.sqlite');
  if (scope === 'repo') return join(repoInfo(root).commonDir, 'pullboard', 'resources.sqlite');
  throw new Refused('BAD_RESOURCE_SCOPE', `unknown resource scope "${scope}"; use machine or repo`);
}

/** Open and initialize the small durable queue database. */
function open(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS resource (name TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS holder (token TEXT PRIMARY KEY, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS holder_name ON holder(name);
    CREATE TABLE IF NOT EXISTS waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pid INTEGER NOT NULL, agent TEXT NOT NULL, repo TEXT NOT NULL, since TEXT NOT NULL, heartbeat INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS waiter_name_ticket ON waiter(name, ticket);`);
  return db;
}

/** Treat a process as alive unless the operating system confirms that its PID is gone. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Run a short serialized database update and discard dead or expired leases. */
function update(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cutoff = Date.now() - LEASE_MS;
    for (const row of db.prepare('SELECT token, pid, heartbeat FROM holder').all()) {
      if (row.heartbeat < cutoff || !alive(row.pid)) db.prepare('DELETE FROM holder WHERE token = ?').run(row.token);
    }
    for (const row of db.prepare('SELECT token, pid, heartbeat FROM waiter').all()) {
      if (row.heartbeat < cutoff || !alive(row.pid)) db.prepare('DELETE FROM waiter WHERE token = ?').run(row.token);
    }
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Current holders and FIFO line for one resource. */
function snapshot(db, name) {
  const holders = db.prepare('SELECT agent, repo, since FROM holder WHERE name = ? ORDER BY since, token').all(name);
  const line = db.prepare('SELECT agent, repo, since FROM waiter WHERE name = ? ORDER BY ticket').all(name);
  return { holders, line };
}

/** Pause briefly between durable queue checks. */
function pause(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

/**
 * Join a resource's FIFO queue and resolve with a renewable lease when capacity is available.
 *
 * @param {{ name: string, capacity: number, scope?: 'machine'|'repo'|'board', root?: string, agent?: string, repo?: string, onWait?: (state: object) => void }} options
 * @returns {Promise<{ name: string, scope: string, token: string, release: () => void, renew: () => void }>}
 */
export async function takeResource(options) {
  const { name, capacity, scope = 'machine', root = process.cwd() } = options;
  if (typeof name !== 'string' || !name.trim() || name.trim() !== name) throw new Refused('BAD_RESOURCE_NAME', 'resource name must be nonempty trimmed text');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be a positive integer');
  const file = databaseFile(scope, root);
  const db = open(file);
  const token = randomUUID();
  const pid = process.pid;
  const agent = options.agent ?? process.env.PULLBOARD_AGENT ?? `pid-${pid}`;
  const repo = options.repo ?? (scope === 'repo' ? repoInfo(root).root : '');
  const since = new Date().toISOString();
  try {
    update(db, () => {
      const row = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name);
      if (row && row.capacity !== capacity) throw new Refused('RESOURCE_CAPACITY_MISMATCH', `resource "${name}" already has capacity ${row.capacity}`);
      db.prepare('INSERT INTO resource(name, capacity) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, capacity);
      db.prepare('INSERT INTO waiter(token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, agent, repo, since, Date.now());
    });
    while (true) {
      const acquired = update(db, () => {
        db.prepare('UPDATE waiter SET heartbeat = ? WHERE token = ?').run(Date.now(), token);
        const spot = snapshot(db, name);
        const position = db.prepare('SELECT count(*) AS count FROM waiter WHERE name = ? AND ticket <= (SELECT ticket FROM waiter WHERE token = ?)').get(name, token).count;
        const limit = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name).capacity;
        if (position === 1 && spot.holders.length < limit) {
          db.prepare('DELETE FROM waiter WHERE token = ?').run(token);
          db.prepare('INSERT INTO holder(token, name, pid, agent, repo, since, heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)').run(token, name, pid, agent, repo, since, Date.now());
          return { acquired: true, state: { ...spot, position: 0 } };
        }
        return { acquired: false, state: { ...spot, position } };
      });
      if (acquired.acquired) {
        let released = false;
        const heartbeat = setInterval(() => {
          if (released) return;
          try { update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token)); } catch { /* Lease expiry remains the crash fallback. */ }
        }, HEARTBEAT_MS);
        heartbeat.unref();
        const release = () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          update(db, () => db.prepare('DELETE FROM holder WHERE token = ?').run(token));
          db.close();
        };
        return { name, scope, token, release, renew: () => update(db, () => db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ?').run(Date.now(), token)) };
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

/** List resources and prune leases whose process died or lease expired. */
export function listResources({ scope = 'machine', root = process.cwd() } = {}) {
  const db = open(databaseFile(scope, root));
  try {
    return update(db, () => db.prepare('SELECT name, capacity FROM resource ORDER BY name').all().map(({ name, capacity }) => ({ name, capacity, ...snapshot(db, name) })));
  } finally { db.close(); }
}
