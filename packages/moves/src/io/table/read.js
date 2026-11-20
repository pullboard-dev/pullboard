/** Read recorded item moves from a board read-only, and find every move table without a central list [C7,#8070]. */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../kernel/light.js';
import { SKIPS_LAPSE } from '../../logic/lifecycle/replay.js';
import { lifecycleFact } from '../../logic/lifecycle/replay.js';
import { apply } from '../../logic/lifecycle/rules.js';
import { leaseLive } from '../../logic/lifecycle/rules.js';
import { newItem } from '../../logic/lifecycle/rules.js';
import { ruleOf } from '../../logic/lifecycle/rules.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { openBoardReadOnly } from '../../../../store/index.js';

const fs = fileSystemAdapter();

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
      WHERE item_id IS NOT NULL ORDER BY event_id`).all();
    const active = new Set(rows.filter(row => row.event_at >= from).map(row => row.item_id));
    const history = new Map();
    const states = new Map();
    const records = [];
    for (const row of rows) {
      const detail = detailOf(row.event_detail);
      const fact = lifecycleFact({ ...detail, id: row.event_id, at: row.event_at, by: row.event_by, kind: row.event_kind, item: row.item_id });
      let item = states.get(row.item_id) ?? (row.event_kind === 'add' ? newItem(row.item_id, fact.after ?? []) : { ...newItem(row.item_id), created: false });
      const rule = ruleOf(fact);
      if (item.status === 'claimed' && !SKIPS_LAPSE.has(rule) && item.leaseUntil && !leaseLive(item, row.event_at)) item = { ...item, status: 'open', owner: null, leaseUntil: null };
      if (row.event_at >= from) {
        const earlier = history.get(row.item_id) ?? [];
        const waits = new Map(item.after.filter(id => states.has(id)).map(id => [id, { ...states.get(id) }]));
        records.push(deepFreeze({
          event: { id: row.event_id, at: row.event_at },
          snapshot: { revision: row.event_id - 1, item: { ...item, after: [...item.after] }, items: waits, actor: { id: row.event_by }, history: earlier.map(prior => ({ ...prior, detail: { ...prior.detail } })) },
          move: { name: row.event_kind, kind: row.event_kind, id: row.item_id, actor: row.event_by, at: row.event_at, detail },
          recorded: { events: [{ kind: row.event_kind, by: row.event_by, detail }] },
        }));
      }
      if (active.has(row.item_id)) history.set(row.item_id, [...(history.get(row.item_id) ?? []), { id: row.event_id, kind: row.event_kind, by: row.event_by, at: row.event_at, detail }]);
      states.set(row.item_id, row.event_kind === 'add' ? { ...item, lastEvent: row.event_id } : apply(item, fact, rule));
    }
    return records;
  } finally {
    if (opened) opened.close();
  }
}

/** Every folder under `directory`, depth first, in name order, skipping hidden folders and node_modules. */
function walk(directory, found) {
  for (const entry of fs.list(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
  if (!fs.exists(packages)) return [];
  const found = [];
  for (const cell of fs.list(packages, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const logic = join(packages, cell.name, 'src/logic');
    if (cell.isDirectory() && fs.exists(logic)) walk(logic, found);
  }
  return found.map(path => path.slice(root.length).replace(/^[\\/]+/u, '').split('\\').join('/')).sort();
}
