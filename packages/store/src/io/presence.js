/** Private heartbeat observations travel as sealed display state, never native board history [B3,H5]. */
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const memory = new WeakMap();
const HEARTBEAT_INTERVAL_MS = 60_000;
export const SEAT_LIVE_WINDOW_MS = 10 * 60_000;
const PRESENCE_BUSY_TIMEOUT_MS = 250;
/** After a busy read, how long later reads of that class reuse the cached rows: a short command waits out the timeout once, not per read (2 s still cost a loaded runner 28 waits). */
const PRESENCE_BUSY_BACKOFF_MS = 30_000;
/** A marker beside the sidecar that a busy read left: later processes of a command skip the wait while it is fresh. */
function busyRecently(file) {
  try { return Date.now() - statSync(`${file}.busy`).mtimeMs < PRESENCE_BUSY_BACKOFF_MS; } catch { return false; }
}

/** Leave the busy marker; best effort, a display cache never fails a command. */
function markBusy(file) {
  try { writeFileSync(`${file}.busy`, ''); } catch { /* best-effort display cache */ }
}

const LOCAL_TABLE = 'heartbeat';
const IMPORTED_TABLE = 'imported_heartbeat';

/** Keep display-only relay observations separate from authenticated local activity. */
function observationMemory(db) {
  let rows = memory.get(db);
  if (!rows) {
    rows = { local: new Map(), imported: new Map(), warned: new Set(), busyUntil: new Map() };
    memory.set(db, rows);
  }
  return rows;
}

/** Accept only canonical ISO timestamps produced by the heartbeat protocol. */
function validHeartbeatAt(at) {
  if (typeof at !== 'string') return false;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === at;
}

/** Read the native board identity once; an unidentifiable board supplies no local liveness. */
function observationIdentity(board) {
  const identity = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value;
  return typeof identity === 'string' && /^[0-9a-f]{32}$/u.test(identity) ? identity : null;
}

/** Locate a board's private observation sidecar without changing the shared board schema. */
function observationFile(board) {
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  return file ? `${file}.presence.sqlite` : null;
}

/** Keep a persisted observation fresh for one minute; clock rollback must replace a future value. */
function observationIsFresh(at, now) {
  const elapsed = now - Date.parse(at);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < HEARTBEAT_INTERVAL_MS;
}

/** Read one existing observation without opening a writer or creating any sidecar schema. */
function persistedObservation(file, key) {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=250');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='heartbeat'").get()) return null;
    const at = db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(key)?.at ?? null;
    return validHeartbeatAt(at) ? at : null;
  } finally { db.close(); }
}

/** Observe authenticated activity, persisting at most once per seat/minute, never as a shared move. */
export function heartbeatSeat(board, id) {
  if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(id)) return false;
  const identity = observationIdentity(board);
  if (identity === null) return false;
  const key = JSON.stringify([identity, id]);
  const at = board.clock.now().toISOString();
  const file = observationFile(board);
  if (!file) {
    const rows = observationMemory(board.db).local;
    if (!observationIsFresh(rows.get(key), Date.parse(at))) rows.set(key, at);
    return true;
  }
  // Why: a locked sidecar would otherwise cost the full busy timeout on every heartbeat of one command.
  const memory = observationMemory(board.db);
  if (Date.now() < (memory.busyUntil.get('write') ?? 0) || busyRecently(file)) return true;
  try {
    if (observationIsFresh(persistedObservation(file, key), Date.parse(at))) return true;
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS heartbeat(seat TEXT PRIMARY KEY, at TEXT NOT NULL)');
      // A peer may have refreshed after the read: recheck under this write transaction.
      db.prepare('INSERT INTO heartbeat(seat,at) VALUES (?,?) ON CONFLICT(seat) DO UPDATE SET at=excluded.at WHERE heartbeat.at<=? OR heartbeat.at>?')
        .run(key, at, new Date(Date.parse(at) - HEARTBEAT_INTERVAL_MS).toISOString(), at);
      return true;
    } finally { db.close(); }
  } catch (error) {
    if ((Number.isInteger(error?.errcode) ? error.errcode & 0xff : null) !== 5 && error?.code !== 'SQLITE_BUSY') throw error;
    memory.busyUntil.set('write', Date.now() + PRESENCE_BUSY_BACKOFF_MS);
    markBusy(file);
    return true;
  }
}

/** A busy class keeps its last rows, says so once per process, and is not read again for the backoff. */
function busyRows(cached, kind) {
  cached.busyUntil.set(kind, Date.now() + PRESENCE_BUSY_BACKOFF_MS);
  if (!cached.warned.has(kind)) {
    cached.warned.add(kind);
    process.emitWarning(`presence sidecar remained locked after ${PRESENCE_BUSY_TIMEOUT_MS}ms; using last known ${kind} observations without refreshing their timestamps`, { code: 'PRESENCE_BUSY' });
  }
  return cached[kind];
}

/** Read one private observation class, retaining its last successful snapshot during bounded contention. */
function observationRows(board, table, kind) {
  const cached = observationMemory(board.db);
  const file = observationFile(board);
  if (!file) return cached[kind];
  // Why: one next reads presence per seat; a locked sidecar would otherwise cost the full timeout on each read.
  if (Date.now() < (cached.busyUntil.get(kind) ?? 0)) return cached[kind];
  if (!existsSync(file)) { cached[kind] = new Map(); return cached[kind]; }
  if (busyRecently(file)) return busyRows(cached, kind);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${PRESENCE_BUSY_TIMEOUT_MS}`);
    const rows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      ? new Map(db.prepare(`SELECT seat,at FROM ${table}`).all()
        .filter(row => validHeartbeatAt(row.at)).map(row => [row.seat, row.at])) : new Map();
    cached[kind] = rows;
    cached.warned.delete(kind);
    cached.busyUntil.delete(kind);
    rmSync(`${file}.busy`, { force: true });
    return rows;
  } catch (error) {
    const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 0xff : null;
    if (sqliteCode !== 5 && error.code !== 'SQLITE_BUSY') throw error;
    markBusy(file);
    return busyRows(cached, kind);
  } finally { db?.close(); }
}

/** Read only the machine-local heartbeat rows used for local activity and throttling. */
function heartbeatRows(board) { return observationRows(board, LOCAL_TABLE, 'local'); }

/** Read only imported display observations; they never qualify as local activity. */
function importedHeartbeatRows(board) { return observationRows(board, IMPORTED_TABLE, 'imported'); }

/** Persist supplied snapshot observations after native restore, without changing the board. */
export function importSeatObservations(board, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const identity = observationIdentity(board);
  if (identity === null) return;
  const known = new Set(board.db.prepare('SELECT agent_id FROM agent').all().map(row => row.agent_id));
  const observations = rows.filter(row => row && known.has(row.agent_id) && validHeartbeatAt(row.heartbeatAt))
    .map(row => [JSON.stringify([identity, row.agent_id]), row.heartbeatAt]);
  if (!observations.length) return;
  const file = observationFile(board);
  if (!file) {
    const imported = observationMemory(board.db).imported;
    for (const [key, at] of observations) if (!validHeartbeatAt(imported.get(key)) || Date.parse(at) > Date.parse(imported.get(key))) imported.set(key, at);
    return;
  }
  // This cache is deliberately best-effort: native restore already committed, so a cache failure
  // must not report a failed import after its irreversible board transaction succeeded.
  let sidecar;
  let inTransaction = false;
  try {
    sidecar = new DatabaseSync(file);
    sidecar.exec('PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS heartbeat(seat TEXT PRIMARY KEY, at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS imported_heartbeat(seat TEXT PRIMARY KEY, at TEXT NOT NULL)');
    sidecar.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const save = sidecar.prepare('INSERT INTO imported_heartbeat(seat,at) VALUES (?,?) ON CONFLICT(seat) DO UPDATE SET at=excluded.at WHERE imported_heartbeat.at<=excluded.at');
    for (const observation of observations) save.run(...observation);
    sidecar.exec('COMMIT');
    inTransaction = false;
  } catch {
    try { if (inTransaction) sidecar.exec('ROLLBACK'); } catch { /* best-effort display cache */ }
  } finally {
    try { sidecar?.close(); } catch { /* best-effort display cache */ }
  }
}

/** Project exact ten/thirty-minute boundaries while retaining the seat's permanent identity. */
export function withSeatPresence(board, seats, { localOnly = false } = {}) {
  const local = heartbeatRows(board);
  const imported = localOnly ? new Map() : importedHeartbeatRows(board);
  const now = board.clock.now().getTime();
  const identity = observationIdentity(board);
  return seats.map(seat => {
    const key = JSON.stringify([identity, seat.agent_id]);
    const localAt = identity === null ? null : local.get(key) ?? null;
    const importedAt = identity === null ? null : imported.get(key) ?? null;
    const heartbeatAt = localAt && importedAt
      ? (Date.parse(localAt) >= Date.parse(importedAt) ? localAt : importedAt)
      : localAt ?? importedAt;
    const elapsed = heartbeatAt === null ? Infinity : Math.max(0, now - Date.parse(heartbeatAt));
    return { ...seat, heartbeatAt, presence: elapsed < SEAT_LIVE_WINDOW_MS ? 'live' : elapsed < 1_800_000 ? 'idle' : 'gone' };
  });
}

/** Project authenticated local activity only; imported relay observations remain display-only. */
export function withLocalSeatPresence(board, seats) {
  return withSeatPresence(board, seats, { localOnly: true });
}

/** A seat silent this long is gone: the seat-gone release rule's two-minute quiet limit (#3447). */
export const SEAT_GONE_QUIET_MS = 2 * 60_000;

/**
 * Whether a seat is gone: it has a recorded local heartbeat, that heartbeat is two minutes old or more, and the seat
 * has written no board event in that time, the same evidence the seat-gone claim release reads. A seat with no
 * recorded heartbeat reads as unknown, never gone, so a hook-less seat keeps what waits for it (#3447).
 */
export function seatGone(board, agentId) {
  const [seat] = withLocalSeatPresence(board, [{ agent_id: agentId }]);
  const beat = Date.parse(seat.heartbeatAt ?? '');
  if (!Number.isFinite(beat)) return false;
  const moved = Date.parse(board.db.prepare('SELECT max(event_at) AS at FROM event WHERE event_by=?').get(agentId)?.at ?? '');
  const last = Number.isFinite(moved) ? Math.max(beat, moved) : beat;
  return board.clock.now().getTime() - last >= SEAT_GONE_QUIET_MS;
}
