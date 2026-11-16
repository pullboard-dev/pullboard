/** Record move table shadow compares on the board, per table, so a table's agreement with its writer is measured on live moves [C7,#8376]. */
import { writeBoardMeta } from './meta.js';

/** The most recent disagreements a table keeps, so the record stays one small row however long the window runs. */
const KEPT = 20;

/** The board_meta key a table's counts live under. */
export const shadowKey = table => `moves.shadow.${table}`;

/**
 * The first path at which two plain JSON values differ, such as `events.0.detail.leaseUntil`, or null when they are equal.
 * Why a path: a disagreement is fixed in one writer or one row, and the path names which field to look at.
 */
export function firstDifference(left, right, path = '') {
  if (Object.is(left, right)) return null;
  const here = path || '(whole)';
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null || Array.isArray(left) !== Array.isArray(right)) return here;
  if (Array.isArray(left) && left.length !== right.length) return `${path ? `${path}.` : ''}length`;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const found = firstDifference(left[key], right[key], path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

/**
 * Add one compare to a table's counts in board_meta: `{ compared, disagreed, since, lastDisagreedAt, last }`, `last` holding the newest disagreements.
 * It runs inside the writer's own transaction, so a compare is recorded exactly when the move it judged commits.
 * Why it never throws: the writer stays the authority while a table is shadowed, so a recording fault must never refuse a move.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, clock?: { now: () => Date } }} board
 * @param {string} table
 * @param {number | string | null} id - The item or job the move was on.
 * @param {string | null} differs - The first differing path, or null when the table agreed.
 */
export function recordShadow(board, table, id, differs) {
  try {
    const at = (board.clock?.now() ?? new Date()).toISOString();
    const key = shadowKey(table);
    const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(key);
    let counts = null;
    try { counts = row ? JSON.parse(row.meta_value) : null; } catch { counts = null; }
    counts ??= { compared: 0, disagreed: 0, since: at, lastDisagreedAt: null, last: [] };
    counts.compared += 1;
    if (differs) {
      counts.disagreed += 1;
      counts.lastDisagreedAt = at;
      counts.last = [...counts.last, { id, at, differs }].slice(-KEPT);
    }
    writeBoardMeta(board.db, key, JSON.stringify(counts));
  } catch { /* A recording fault leaves the move as the writer wrote it. */ }
}

/** A table's recorded counts, or null when nothing was recorded for it. */
export function readShadow(board, table) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(shadowKey(table));
  try { return row ? JSON.parse(row.meta_value) : null; } catch { return null; }
}

/**
 * The shadow hook a writer hands its compare to: the board's own hook when a caller set one (a store test), else, with
 * moves.shadow on, one that records `differs(answer)` for `table`, else null so the writer runs no table at all.
 * A board's own `movesShadow` stands in for the machine setting, as `executionEngineVersion` stands in for the engine.
 *
 * @param {object} board
 * @param {string} name - The board property a test sets, such as `claimShadow`.
 * @param {string} table
 * @param {(answer: object) => string | null} differs - What the writer's compare finds: the first differing path, or null.
 * @param {() => boolean} enabled - The moves.shadow machine setting, read by the writer, which already reads config.
 * @returns {((answer: object) => void) | null}
 */
export function shadowHook(board, name, table, differs, enabled) {
  if (typeof board[name] === 'function') return board[name];
  if (!(board.movesShadow ?? enabled())) return null;
  const record = answer => recordShadow(board, table, answer.id ?? null, differs(answer));
  record.recorder = true;
  return record;
}

/**
 * Run a writer's table decision for its shadow hook. Under the recorder a table that throws is answered `{ threw }` and
 * recorded as a disagreement; a test's own hook still sees the throw.
 */
export function shadowDecide(hook, decide) {
  if (!hook.recorder) return decide();
  try { return decide(); } catch (error) { return { threw: error?.code ?? String(error?.message ?? error) }; }
}

/** A claim event as the board stores it, without the actor's stamped model or a fact's random id, which differ on every write. */
function stored({ kind, by, detail }) {
  const copy = JSON.parse(JSON.stringify({ kind, by, detail: typeof detail === 'string' ? JSON.parse(detail) : detail }));
  delete copy.detail?.model;
  if (copy.kind === 'fact') delete copy.detail.id;
  return copy;
}

/**
 * Where the claim table's answer and the claim writer's events part: `refused` when the table refused a claim the writer made,
 * else the first differing path between the two event lists, or null when they agree.
 */
export function claimDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  if (decided?.refused) return 'refused';
  return firstDifference((decided?.events ?? []).map(stored), wrote.map(stored), 'events');
}

/**
 * Every table's recorded counts, keyed by table name; tables with nothing recorded are absent.
 * Why: `pullboard moves` reports the whole board in one read, and a table added later needs no edit here.
 */
export function readShadows(board) {
  const found = {};
  for (const { meta_key: key, meta_value: value } of board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB 'moves.shadow.*' ORDER BY meta_key").all()) {
    try { found[key.slice('moves.shadow.'.length)] = JSON.parse(value); } catch { /* A damaged row reads as nothing recorded. */ }
  }
  return found;
}
