/** Advisory process-owned write records; never part of native board state or lock authority [C7,P4]. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from './windows-child-process.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { readSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { parseProcessCensus } from './process-census.js';

const pending = new WeakMap();
let ownIdentity;
let identityPrepared = false;
const LONG_WRITE_MS = 2_000;

/** Run one bounded PID-only query, without reading or changing any other process's arguments or state. */
function identities(pids) {
  if (!pids.length) return new Map();
  try {
    const result = spawnSync('/bin/ps', ['-p', [...new Set(pids)].join(','), '-o', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    });
    return result.error || result.status !== 0 ? new Map() : parseProcessCensus(result.stdout) ?? new Map();
  } catch { return new Map(); /* Optional process metadata cannot replace the original move or refusal. */ }
}

/** Prepare once BEFORE acquiring SQLite's outer write lock, including when process metadata is unavailable. */
export function prepareBoardWriteIdentity() {
  if (identityPrepared) return;
  identityPrepared = true;
  ownIdentity = identities([process.pid]).get(process.pid) ?? null;
}

/** Resolve a real database's local sidecar directory; memory boards have no filesystem publication. */
function boardFile(db) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  return file ? realpathSync(file) : null;
}

/** Keep labels bounded and single-line; no user note, SQL, parameters, or session material is recorded. */
function label(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,100}$/u.test(value) ? value : fallback;
}

/** Report journal conversion's total wait-plus-hold separately: SQLite exposes no acquisition boundary. */
export function configureBoardJournal(db, context = {}) {
  const start = performance.now();
  let outcome = 'failed';
  try {
    db.exec('PRAGMA journal_mode = WAL');
    outcome = 'completed';
  } finally {
    const durationMs = Math.max(0, Math.round(performance.now() - start));
    if (durationMs > LONG_WRITE_MS) {
      try {
        const line = { operation: 'journal_mode', timing: 'wait-plus-hold', command: label(context.command, 'api'),
          seat: label(context.seat, 'unknown'), pid: process.pid, durationMs, outcome };
        writeSync(2, 'pullboard: long board operation ' + JSON.stringify(line) + '\n');
      }
      catch { /* Optional diagnostics must preserve journal conversion's original result or refusal. */ }
    }
  }
}

/** Resolve a registered seat from the caller's checkout, only after SQLite grants this write transaction. */
function contextFor(db, context) {
  let seat = context.seat;
  if (!seat && context.path && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent'").get()) {
    seat = db.prepare('SELECT agent_id FROM agent WHERE agent_path=?').get(context.path)?.agent_id;
  }
  return { command: label(context.command, 'api'), seat: label(seat, 'unknown') };
}

/** Start tracking AFTER successful BEGIN; slow admission is never misreported as lock-holding time. */
export function beginBoardWrite(db, context = {}) {
  const record = { db, start: performance.now(), acquiredAt: Date.now(), pid: process.pid,
    command: 'api', seat: 'unknown', marker: null, complete: false };
  let records = pending.get(db);
  if (!records) { records = new Set(); pending.set(db, records); }
  records.add(record);
  try {
    Object.assign(record, contextFor(db, context));
    const file = boardFile(db);
    if (!file) return record;
    if (!ownIdentity || ownIdentity.state.startsWith('Z')) return record;
    const directory = file + '.write-holders';
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) return record;
    const marker = join(directory, `${process.pid}-${randomUUID()}.json`);
    const detail = { version: 1, pid: process.pid, started: ownIdentity.started, processSha256: ownIdentity.processSha256,
      command: record.command, seat: record.seat, acquiredAt: record.acquiredAt };
    writeFileSync(marker, JSON.stringify(detail) + '\n', { flag: 'wx', mode: 0o600 });
    record.marker = marker;
  } catch { /* Optional diagnostics cannot refuse, roll back, or change a native move. Unknown holders stay unknown. */ }
  return record;
}

/** Complete only after COMMIT/ROLLBACK or actual connection close; unique records cannot unlink a successor. */
export function finishBoardWrite(record, released, outcome = 'released') {
  if (!record || record.complete || !released) return;
  record.complete = true;
  const durationMs = Math.max(0, Math.round(performance.now() - record.start));
  if (durationMs > LONG_WRITE_MS) {
    const line = { command: record.command, seat: record.seat, pid: record.pid, durationMs, outcome };
    try { writeSync(2, 'pullboard: long board write ' + JSON.stringify(line) + '\n'); }
    catch { /* A closed diagnostic stream must not turn an already committed move into an apparent refusal. */ }
  }
  if (record.marker) {
    try { unlinkSync(record.marker); }
    catch { /* Retain a stale advisory file if cleanup is unavailable; PID/start checks keep it non-authoritative. */ }
  }
  pending.get(record.db)?.delete(record);
}

/** A failed release remains observable until the caller actually closes the SQLite connection. */
export function closeBoardWrites(db) {
  for (const record of pending.get(db) ?? []) finishBoardWrite(record, true, 'connection-closed');
  pending.delete(db);
}

/** Read only a bounded regular sidecar file, never a link or arbitrary native board content. */
function readMarker(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4_096) return null;
    const buffer = Buffer.alloc(stat.size);
    if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return null;
    const value = JSON.parse(buffer.toString('utf8'));
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isFinite(value.acquiredAt)
      || typeof value.started !== 'string' || value.started.length > 100 || !/^[a-f0-9]{64}$/u.test(value.processSha256 ?? '')) return null;
    return value;
  } catch { return null; /* Advisory corruption/missing publication never replaces the original BOARD_BUSY refusal. */ }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch { /* Optional marker descriptor cleanup cannot replace the original BOARD_BUSY refusal. */ }
    }
  }
}

/** Describe fresh observed writers, expressly advisory: SQLite and filesystem completion are not atomic. */
export function boardWriteHolderText(file) {
  let directory;
  let candidates;
  try {
    directory = realpathSync(file) + '.write-holders';
    if (!lstatSync(directory).isDirectory()) return '';
    candidates = readdirSync(directory).filter(name => /^\d+-[a-f0-9-]+\.json$/u.test(name)).map(name => {
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        return stat.isFile() ? { path, at: stat.mtimeMs } : null;
      } catch { return null; /* A completed writer can remove its own record during this advisory read. */ }
    }).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 32).map(row => readMarker(row.path)).filter(Boolean);
  } catch { return ''; /* No sidecar is a normal case for older/raw SQLite writers; do not create or repair anything here. */ }
  const live = identities(candidates.map(row => row.pid));
  const holders = candidates.filter(row => {
    const identity = live.get(row.pid);
    return identity && !identity.state.startsWith('Z') && identity.started === row.started && identity.processSha256 === row.processSha256;
  }).slice(0, 3).map(row => ({ command: label(row.command, 'unknown'), seat: label(row.seat, 'unknown'), pid: row.pid,
    observedMs: Math.max(0, Date.now() - row.acquiredAt) }));
  return holders.length ? '; observed writer records (advisory): ' + JSON.stringify(holders) : '';
}
