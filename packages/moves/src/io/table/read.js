/** Read recorded item moves from a board read-only, and find every move table without a central list [C7,#8070]. */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../kernel/light.js';
import { openBoardReadOnly } from '../../../../store/index.js';

/** The repository root, five folders above this file. */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Freeze a value all the way down, so a table can never change what it reads. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** An event's detail as an object; the board writes JSON, and a damaged row reads as empty rather than stopping the read. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** The board's own time for `since`: ISO text or epoch milliseconds, as an ISO string events compare against. */
function cutText(since) {
  const at = typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(at)) throw new Refused('READ_SINCE', 'reading recorded moves needs the cut as a time, and got none that parses', 'pass { since } as the v0.9.4 tag commit time (ISO text or epoch milliseconds)');
  return new Date(at).toISOString();
}

/**
 * Read every recorded item move since a time, each with the frozen snapshot it saw, in event order.
 * The board is opened read-only (or the open board given is only SELECTed), so its bytes never change.
 * A record is the shape replayTable() takes: the snapshot holds the item's earlier events, the actor and the revision just before the move;
 * `recorded.events` is the one event the board wrote for it. Why: replay must judge a table against what the board saw, never against today's rows.
 *
 * @param {string | { db: { prepare: (sql: string) => { all: (...args: any[]) => any[] } } }} board - A board file path, or an open board.
 * @param {{ since: string | number }} options - `since`: the instant (ISO text or epoch milliseconds) the records start at, inclusive.
 * @returns {{ event: { id: number, at: string }, snapshot: object, move: object, recorded: { events: object[] } }[]}
 */
export function readMoveRecords(board, { since } = {}) {
  const from = cutText(since);
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    const db = opened ?? board.db;
    const rows = db.prepare(`
      SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event
      WHERE item_id IN (SELECT DISTINCT item_id FROM event WHERE item_id IS NOT NULL AND event_at >= ?)
      ORDER BY event_id`).all(from);
    const history = new Map();
    const records = [];
    for (const row of rows) {
      const earlier = history.get(row.item_id) ?? [];
      const event = { id: row.event_id, kind: row.event_kind, by: row.event_by, at: row.event_at, detail: detailOf(row.event_detail) };
      if (row.event_at >= from) {
        records.push(deepFreeze({
          event: { id: row.event_id, at: row.event_at },
          snapshot: { revision: row.event_id - 1, item: { id: row.item_id }, actor: { id: row.event_by }, history: earlier.map(prior => ({ ...prior, detail: { ...prior.detail } })) },
          move: { kind: row.event_kind, id: row.item_id, actor: row.event_by },
          recorded: { events: [{ kind: row.event_kind, by: row.event_by, detail: event.detail }] },
        }));
      }
      earlier.push(event);
      history.set(row.item_id, earlier);
    }
    return records;
  } finally {
    if (opened) opened.close();
  }
}

/** Every folder under `directory`, depth first, in name order, skipping hidden folders and node_modules. */
function walk(directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(path, found);
    else if (entry.isFile() && entry.name.endsWith('.table.js')) found.push(path);
  }
}

/**
 * Find every `*.table.js` under each cell's `src/logic` folder, as paths relative to `root`, sorted.
 * Why: a table is found by where it lives and what it is called, so adding one needs no edit to any list (RFC 0006 CD30).
 *
 * @param {string} [root] - The repository root; defaults to this checkout.
 * @returns {string[]}
 */
export function listMoveTables(root = REPO_ROOT) {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];
  const found = [];
  for (const cell of readdirSync(packages, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const logic = join(packages, cell.name, 'src', 'logic');
    if (cell.isDirectory() && existsSync(logic)) walk(logic, found);
  }
  return found.map(path => path.slice(root.length).replace(/^[\\/]+/u, '').split('\\').join('/')).sort();
}
