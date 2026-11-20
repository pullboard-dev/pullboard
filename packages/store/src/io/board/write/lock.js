import { processMachineHome as machineHome } from '../../../../../kernel/light.js';
/** Advisory process-owned write records; never part of native board state or lock authority [C7,P4]. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import { parseProcessCensus } from "../../../../../kernel/light.js";
import { recordBoardHold } from "../hold/log.js";
import { storeName } from '../../store-names.js';
import { channel } from 'node:diagnostics_channel';

/** Each write transaction's start and end, so a command's remembered item list reads again (read/light.js, #12010). */
const WRITES = channel('pullboard:board-write');

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

/** The board's database path as SQLite reports it, with no filesystem I/O; null for a memory board [C7]. */
function openBoardFile(db) {
  try { return db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || null; } catch { return null; }
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
  return { command: label(context.command, 'api'), seat: label(seat, 'unknown'),
    item: Number.isSafeInteger(context.item) && context.item > 0 ? context.item : null };
}

/** Publish an advisory contender before waiting for SQLite; it may be waiting or holding. */
export function prepareBoardWriteMarker(db, context = {}) {
  try {
    const file = boardFile(db);
    if (!file || !ownIdentity || ownIdentity.state.startsWith('Z')) return null;
    const directory = file + '.write-holders';
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) return null;
    const marker = join(directory, `${process.pid}-${storeName(randomUUID())}`);
    const labels = contextFor(db, context);
    const detail = { version: 1, pid: process.pid, started: ownIdentity.started, processSha256: ownIdentity.processSha256,
      command: labels.command, seat: labels.seat, acquiredAt: Date.now(), contender: true };
    writeFileSync(marker, JSON.stringify(detail) + '\n', { flag: 'wx', mode: 0o600 });
    return marker;
  } catch { return null; }
}

/** Remove an advisory contender after failed admission or after releasing the transaction. */
export function discardBoardWriteMarker(marker) {
  if (marker) try { unlinkSync(marker); } catch { /* Advisory cleanup cannot change the move. */ }
}

/** Start timing after BEGIN without filesystem I/O. */
export function beginBoardWrite(db, context = {}, marker = null) {
  if (WRITES.hasSubscribers) WRITES.publish(db);
  const record = { db, start: performance.now(), acquiredAt: Date.now(), pid: process.pid,
    command: 'api', seat: 'unknown', marker, complete: false, boardFile: openBoardFile(db) };
  let records = pending.get(db);
  if (!records) { records = new Set(); pending.set(db, records); }
  records.add(record);
  try { Object.assign(record, contextFor(db, context)); } catch { /* Advisory labels are optional. */ }
  return record;
}

/**
 * Account a named synchronous part of the active writer without performing diagnostic I/O.
 * A call that passes `move` is the move body: the record names the move, and the slowest phase measured
 * inside it becomes the record's step, so a long hold can be read to its cause (#3336).
 *
 * @param {object} db - The board connection whose active write is measured.
 * @param {string} name - The phase name.
 * @param {() => *} work - The synchronous work to time.
 * @param {string} [move] - The move name when this phase is the move body.
 * @returns {*} The work's result.
 */
export function measureBoardWritePhase(db, name, work, move) {
  const started = performance.now();
  if (move) for (const record of pending.get(db) ?? []) {
    if (record.complete) continue;
    record.move = move;
    record.moveDepth = (record.moveDepth ?? 0) + 1;
  }
  try { return work(); } finally {
    const elapsed = performance.now() - started;
    for (const record of pending.get(db) ?? []) {
      if (record.complete) continue;
      if (move) record.moveDepth = Math.max(0, (record.moveDepth ?? 1) - 1);
      else if (record.moveDepth > 0 && elapsed > (record.stepMs ?? 0)) { record.step = name; record.stepMs = elapsed; }
      record.workAccountedMs = (record.workAccountedMs ?? 0) + elapsed;
      if (elapsed > (record.phaseMs ?? 0)) { record.phase = name; record.phaseMs = elapsed; }
    }
  }
}

/** Enrich API and nested-command observations from native events, without recording event contents. */
export function noteBoardWriteItem(db, item) {
  if (!Number.isSafeInteger(item) || item < 1) return;
  for (const record of pending.get(db) ?? []) {
    if (record.complete || record.multipleItems) continue;
    if (record.item == null) record.item = item;
    else if (record.item !== item) { record.item = null; record.multipleItems = true; }
  }
}

/** Locate per-command write measurements in private machine storage, outside native board state. */
export function boardWriteLog() { return join(machineHome(), 'board-writes.jsonl'); }

/** Complete only after COMMIT/ROLLBACK or actual connection close; unique records cannot unlink a successor. */
export function finishBoardWrite(record, released, outcome = 'released') {
  if (WRITES.hasSubscribers) WRITES.publish(record?.db);
  if (!record || record.complete || !released) return;
  record.complete = true;
  const durationMs = Math.max(0, Math.round((record.releasedAt ?? performance.now()) - record.start));
  if (durationMs > LONG_WRITE_MS) {
    const line = { command: record.command, seat: record.seat, item: record.item ?? null, pid: record.pid, durationMs, outcome };
    try { writeSync(2, 'pullboard: long board write ' + JSON.stringify(line) + '\n'); }
    catch { /* A closed diagnostic stream must not turn an already committed move into an apparent refusal. */ }
  }
  recordBoardHold({ ...record, durationMs, outcome });
  recordBoardHold({ ...record, durationMs, outcome, allWrites: true });
  if (record.marker) try { unlinkSync(record.marker); } catch { /* Optional advisory cleanup. */ }
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

/**
 * Remove writer records whose process has exited, or whose pid now names a later process (another start time). Why:
 * a writer killed mid-move never removed its record; 23 such records from 26 Oct to 9 Nov sat beside the board and
 * read as possible holders. A live process ps could not describe keeps its record.
 */
function reclaimDeadMarkers(candidates, live) {
  for (const row of candidates) {
    let gone = false;
    try { process.kill(row.pid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
    const identity = live.get(row.pid);
    if (!gone && identity && (identity.state.startsWith('Z') || identity.started !== row.started)) gone = true;
    if (gone) try { unlinkSync(row.path); } catch { /* Its writer or another reader removed it first. */ }
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
    }).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 32).map(row => ({ ...readMarker(row.path), path: row.path })).filter(row => row.pid);
  } catch { return ''; /* No sidecar is a normal case for older/raw SQLite writers; do not create anything here. */ }
  const live = identities(candidates.map(row => row.pid));
  reclaimDeadMarkers(candidates, live);
  const holders = candidates.filter(row => {
    const identity = live.get(row.pid);
    return identity && !identity.state.startsWith('Z') && identity.started === row.started && identity.processSha256 === row.processSha256;
  }).slice(0, 3).map(row => ({ command: label(row.command, 'unknown'), seat: label(row.seat, 'unknown'), pid: row.pid,
    observedMs: Math.max(0, Date.now() - row.acquiredAt), ...(row.contender ? { state: 'waiting or holding' } : {}) }));
  return holders.length ? '; observed writer records (advisory): ' + JSON.stringify(holders) : '';
}
