/** Read each native session log once: a cursor resumes at its last byte offset and never rereads or rehashes old bytes [N2]. */
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { claudeStep } from './provider.js';
import { codexStep } from './provider.js';
import { SPLIT_COUNTS } from './usage.js';

/** A cursor no checkpoint has used for a week is dropped from the private ledger. */
const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FIELDS = ['inputTokens', 'outputTokens', ...SPLIT_COUNTS];

/** Add provider counts without silently rounding overflow or masking an unknown field. */
function add(left, right) {
  return left !== null && right !== null && Number.isSafeInteger(left + right) ? left + right : null;
}

/** A cursor at byte zero of one file identity. */
function fresh(provider, stat) {
  return { provider, dev: stat.dev, ino: stat.ino, offset: 0, cutoff: 0, broken: false, count: 0, totals: {}, last: null, codex: {}, messages: [] };
}

/** Fold one Codex event into the committed per-model totals; the latest model is the last event in file order. */
function commit(cursor, event) {
  const model = event.model ?? 'unknown';
  const total = cursor.totals[model] ?? Object.fromEntries(FIELDS.map((name) => [name, 0]));
  cursor.totals[model] = Object.fromEntries(FIELDS.map((name) => [name, add(total[name], event[name])]));
  cursor.count++;
  cursor.last = { at: event.at, model: event.model };
}

/**
 * Apply one parsed row. Codex counters fold into totals at once; every Claude message stays keyed by its native id
 * for the cursor's life, because a streamed update may arrive any number of messages later and must replace it.
 */
function step(cursor, messages, row) {
  if (row === null) { cursor.broken = true; return; }
  if (cursor.provider === 'codex') {
    const event = codexStep(cursor.codex, row);
    if (cursor.codex.broken) cursor.broken = true;
    else if (event) commit(cursor, event);
    return;
  }
  if (cursor.provider === 'claude') claudeStep(messages, row);
}

/** Run rows through one cursor, keeping its messages serializable for the private ledger. */
function apply(cursor, rows) {
  const messages = new Map(cursor.messages);
  for (const row of rows) if (!cursor.broken) step(cursor, messages, row);
  cursor.messages = [...messages];
}

/** Consume complete lines up to the cutoff; a later row waits for a later checkpoint. Returns the bytes consumed. */
function feed(cursor, bytes, cutoff) {
  const messages = new Map(cursor.messages);
  let start = 0;
  for (let end = bytes.indexOf(10, start); end !== -1; end = bytes.indexOf(10, start)) {
    let row;
    let parsed = true;
    try { row = JSON.parse(bytes.subarray(start, end).toString('utf8')); } catch { parsed = false; }
    if (parsed) {
      const at = Date.parse(row?.timestamp);
      if (Number.isFinite(at) && at > cutoff) break;
      if (!cursor.broken) step(cursor, messages, row);
    }
    start = end + 1;
  }
  cursor.messages = [...messages];
  cursor.offset += start;
  return start;
}

/** Read only bytes [offset, size) of the file. */
function readFrom(file, offset, size) {
  const bytes = Buffer.alloc(Math.max(0, size - offset));
  const fd = openSync(file, 'r');
  try {
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, offset + read);
      if (!n) break;
      read += n;
    }
    return bytes.subarray(0, read);
  } finally { closeSync(fd); }
}

/**
 * Totals and latest model of the folded Codex events plus every Claude message, or null with no usage record.
 * Claude sorts by first-seen time with ties in file order, as the whole-file reader does.
 */
function totalsOf(cursor) {
  if (cursor.broken) return null;
  const totals = structuredClone(cursor.totals);
  let last = cursor.last;
  for (const [, event] of cursor.messages) {
    const model = event.model ?? 'unknown';
    const total = totals[model] ?? Object.fromEntries(FIELDS.map((name) => [name, 0]));
    totals[model] = Object.fromEntries(FIELDS.map((name) => [name, add(total[name], event[name])]));
    if (!last || event.at >= last.at) last = { at: event.at, model: event.model };
  }
  if (!cursor.count && !cursor.messages.length) return null;
  return { totals, model: last?.model ?? null };
}

/**
 * Cumulative per-model totals of one session log at a cutoff, reading only bytes past the cached cursor.
 * Why: re-reading and hashing whole agent logs on every checkpoint cost most of a 94 s claim on the live board.
 */
export function cursorSnapshot(source, stat, cutoff, cursors) {
  const cached = cursors?.[source.file];
  // A cursor from before #2504's review folded old Claude messages away; it is reread once from byte zero.
  const reusable = cached && Array.isArray(cached.messages) && cached.provider === source.provider && cached.dev === stat.dev && cached.ino === stat.ino
    && stat.size >= cached.offset && cutoff >= cached.cutoff;
  const cursor = reusable ? cached : fresh(source.provider, stat);
  const bytes = readFrom(source.file, cursor.offset, stat.size);
  const consumed = feed(cursor, bytes, cutoff);
  // An earlier-cutoff reread never replaces a cursor that is already further along.
  if (cursors && Number.isFinite(cutoff) && (reusable || !(cached?.cutoff > cutoff))) {
    cursor.cutoff = Math.max(cursor.cutoff, cutoff);
    cursors[source.file] = cursor;
  }
  let view = cursor;
  const tail = bytes.subarray(consumed);
  // An unterminated last line counts when it parses, exactly as a whole-file read would, but stays unconsumed.
  if (tail.length && tail.indexOf(10) === -1) {
    try {
      const row = JSON.parse(tail.toString('utf8'));
      const at = Date.parse(row?.timestamp);
      if (!(Number.isFinite(at) && at > cutoff)) { view = structuredClone(cursor); apply(view, [row]); }
    } catch { /* a partial line is still being written */ }
  }
  const result = totalsOf(view);
  return result && { ...result, dev: stat.dev, ino: stat.ino, bytes: stat.size };
}

/** Drop cursors no checkpoint has used within the TTL so the private ledger stays small. */
export function pruneCursors(cursors, now) {
  for (const [file, cursor] of Object.entries(cursors ?? {})) if (!(cursor.cutoff >= now - CURSOR_TTL_MS)) delete cursors[file];
}
