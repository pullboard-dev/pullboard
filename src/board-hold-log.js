/** Machine-local observations of actual SQLite holds, never native board or replay state [C7,P4]. */
import { constants } from 'node:fs';
import { closeSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { machineHome } from './machine-home.js';

export const BOARD_HOLD_MS = 1_000;
const DAY_MS = 86_400_000;
const MAX_READ_BYTES = 32 * 1024 * 1024;

/** Resolve private machine storage independently of any repository or relay. */
export function boardHoldLog() { return join(machineHome(), 'board-holds.jsonl'); }

/** Keep only bounded operational labels, never CLI arguments, notes, SQL or session material. */
function label(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,100}$/u.test(value) ? value : fallback;
}

/** Append one bounded line after release; diagnostic I/O must never change a transaction's outcome. */
export function recordBoardHold({ command, seat, item, durationMs, outcome, acquiredAt }) {
  if (!Number.isFinite(durationMs) || durationMs <= BOARD_HOLD_MS) return;
  let fd;
  try {
    const directory = machineHome();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    fd = openSync(boardHoldLog(), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (!fstatSync(fd).isFile()) throw new Error('hold log is not a regular file');
    const row = { version: 1, at: new Date(acquiredAt).toISOString(), command: label(command, 'api'),
      seat: label(seat, 'unknown'), item: Number.isSafeInteger(item) && item > 0 ? item : null,
      heldMs: Math.round(durationMs), outcome: label(outcome, 'released') };
    writeSync(fd, JSON.stringify(row) + '\n');
  } catch {
    try { writeSync(2, 'pullboard: board hold log unavailable; original transaction outcome retained\n'); }
    catch { /* A closed diagnostic stream cannot change the original outcome either. */ }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch { /* Closing an optional log must preserve the committed move or original refusal. */ }
    }
  }
}

/** Read a bounded tail, explicitly qualifying a report that cannot cover the entire retained log. */
function retainedHolds() {
  let fd;
  try {
    fd = openSync(boardHoldLog(), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('hold log is not a regular file');
    const start = Math.max(0, stat.size - MAX_READ_BYTES), buffer = Buffer.alloc(stat.size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, count).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0, available: true };
  } catch (error) {
    return { text: '', truncated: false, available: error.code === 'ENOENT' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch { /* Reading diagnostic history does not own a board move. */ }
    }
  }
}

/** Count recorded holds in a half-open window, retaining per-command maxima and UTC day counts. */
export function boardHoldStats({ since, until = Date.now() } = {}) {
  const end = typeof until === 'number' ? until : Date.parse(until);
  const start = since === undefined ? end - DAY_MS : typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new RangeError('board hold window needs ordered finite timestamps');
  const retained = retainedHolds(), commands = new Map(), days = new Map();
  const today = new Date(end).toISOString().slice(0, 10), todayStart = Date.parse(today);
  let count = 0, invalidLines = 0, todayCount = 0;
  for (const line of retained.text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); }
    catch { invalidLines++; continue; }
    const at = Date.parse(row.at);
    if (row.version !== 1 || !Number.isFinite(at) || !Number.isSafeInteger(row.heldMs) || row.heldMs <= BOARD_HOLD_MS
      || label(row.command, null) === null || label(row.seat, null) === null) { invalidLines++; continue; }
    if (at >= todayStart && at < end) todayCount++;
    if (at < start || at >= end) continue;
    count++;
    const day = new Date(at).toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
    const group = commands.get(row.command) ?? { command: row.command, count: 0, slowestMs: 0 };
    group.count++; group.slowestMs = Math.max(group.slowestMs, row.heldMs); commands.set(row.command, group);
  }
  return { since: new Date(start).toISOString(), until: new Date(end).toISOString(), thresholdMs: BOARD_HOLD_MS,
    count: retained.available ? count : null, today, todayCount: retained.available ? todayCount : null,
    available: retained.available, truncated: retained.truncated, invalidLines,
    days: Object.fromEntries([...days].sort()),
    commands: [...commands.values()].sort((a, b) => b.slowestMs - a.slowestMs || a.command.localeCompare(b.command)) };
}

/** Keep absent or bounded history explicit instead of presenting an unmeasured total as zero. */
export function boardHoldLines(stats, baseline) {
  if (!stats.available) return ['board write holds >1s: log unavailable'];
  return [`board write holds >1s: ${stats.count} recorded${stats.truncated ? ' (bounded log tail; incomplete history)' : ''}`,
    ...stats.commands.slice(0, 5).map(row => `  ${row.command}: ${row.count} holds; slowest ${row.slowestMs} ms`),
    ...(baseline?.allowancePerDay === null ? ['WARNING: board hold allowance is unmeasured; record the first full UTC day and its fact before setting it.']
      : baseline && stats.todayCount > baseline.allowancePerDay
        ? [`WARNING: ${stats.todayCount} recorded holds on ${stats.today} exceed the daily allowance ${baseline.allowancePerDay}.`]
        : []),
    ...(stats.invalidLines ? [`WARNING: ${stats.invalidLines} invalid hold log lines were not counted.`] : [])];
}
