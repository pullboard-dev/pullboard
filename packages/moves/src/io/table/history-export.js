/** Export a board's landing and verify history, read-only and scrubbed, as replay fixture documents with each decision's derived landing value [M1]. */
import { homedir } from 'node:os';
import { Refused } from '../../../../kernel/light.js';
import { openBoardReadOnly } from '../../../../store/index.js';
import { landingOf } from '../../logic/table/rules.js';
import { readLandingMoveRecords } from './landing-records.js';
import { readVerifyRecords } from './verify-records.js';

/** The event kinds the landing reader folds; any other row cannot change a landing decision. */
const LANDING_KINDS = Object.freeze(['add', 'edit', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'hold_item', 'unhold_item', 'claim', 'release', 'refreeze',
  'merge-only-accept', 'reland', 'landing_batch', 'landing_lease', 'main-moved', 'landing_waiver']);
/** The landing reader's decision lists, in the order the export names them. */
const LANDING_TABLES = Object.freeze(['select', 'selection', 'record', 'merged', 'outcome']);
/** The verify reader reads this many events after a verdict as its follow-ups. */
const FOLLOW = 8;
/** Itemless events the verify fold reads: an agent's route change and its flake observations. */
const AGENT_KINDS = Object.freeze(['join', 'flake-observation']);
/** A home folder on macOS or Linux, up to the user's name. */
const HOME_PATH = /\/(?:Users|home)\/[^/\s"'\\]+/gu;

/**
 * A copy of a value with every home folder replaced by `~`: the person's own, and any other user's under /Users or /home.
 * Why: a fixture is committed and published, so it must never carry a machine's user name or folder layout.
 *
 * @param {unknown} value
 * @param {string} home
 * @returns {unknown}
 */
export function scrubHome(value, home = homedir()) {
  if (typeof value === 'string') return (home && home !== '/' ? value.split(home).join('~') : value).replace(HOME_PATH, '~');
  if (Array.isArray(value)) return value.map(entry => scrubHome(entry, home));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubHome(entry, home)]));
  return value;
}

/** A recorded detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * The landing value a recorded decision saw: the decided item's, or each item's for a batch decision.
 * Why: Steady replays unchanged only if the landing dimension agrees with the merged commit each decision read.
 *
 * @param {{ snapshot: { item?: object, items?: Record<string, object> } }} record
 * @returns {string | Record<string, string>}
 */
export function recordLanding(record) {
  const { item, items } = record.snapshot ?? {};
  if (item) return landingOf(item);
  return Object.fromEntries(Object.entries(items ?? {}).map(([id, entry]) => [id, landingOf(entry)]));
}

/**
 * Write a board's landing and verify history as two scrubbed documents, only SELECTing from it.
 * Each document holds the board rows its reader needs, in the shape the replay fixtures load, plus `decisions`: one entry per decision the reader rebuilds,
 * with that decision's derived landing value. The landing rows are every row its reader folds; the verify rows cover each item with a verdict in the window.
 * Why: the replay fixtures are refreshed from real history, and the landing dimension must be shown on every decision before Steady is trusted unchanged.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string, merged?: number[], verdicts?: number[], home?: string }} options - ISO cut; `merged` and `verdicts` sample event ids as the readers' `only` does.
 * @returns {{ landing: object, verify: object }}
 */
export function exportTableHistory(board, { since, merged, verdicts, home = homedir() }) {
  if (!Number.isFinite(Date.parse(since))) throw new Refused('READ_SINCE', 'exporting recorded history needs a time, and got none that parses', 'pass { since } as ISO text');
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    const source = opened ? { db: opened } : board;
    return scrubHome({ landing: landingDocument(source, since, merged), verify: verifyDocument(source, since, verdicts) }, home);
  } finally {
    if (opened) opened.close();
  }
}

/** The landing document: the rows the landing reader folds and one decision per rebuilt record. */
function landingDocument(board, since, merged) {
  const rows = board.db.prepare(`SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event WHERE event_kind IN (${LANDING_KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(...LANDING_KINDS);
  const records = readLandingMoveRecords(board, { since, only: merged });
  const decisions = LANDING_TABLES.flatMap(table => records[table].map(record => ({ table, event: record.event.id, landing: recordLanding(record) })));
  return {
    since,
    merged: merged ?? records.merged.map(record => record.event.id),
    events: rows.map(row => [row.event_id, row.event_at, row.event_by, row.event_kind, row.item_id, detailOf(row.event_detail)]),
    decisions,
    unreplayable: records.unreplayable,
  };
}

/** The verify document: the items with a verdict in the window, their rows and follow-ups, and one decision per rebuilt verdict. */
function verifyDocument(board, since, only) {
  const { db } = board;
  const wanted = only ? new Set(only) : null;
  const verdictEvents = db.prepare("SELECT event_id, item_id FROM event WHERE event_kind IN ('accept', 'reject') AND event_at >= ? ORDER BY event_id").all(since)
    .filter(row => !wanted || wanted.has(row.event_id));
  const items = new Set(verdictEvents.map(row => row.item_id));
  const all = db.prepare('SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event ORDER BY event_id').all();
  const ids = new Set(all.filter(row => items.has(row.item_id)).map(row => row.event_id));
  const positions = new Map(all.map((row, index) => [row.event_id, index]));
  for (const { event_id: id } of verdictEvents) for (const row of all.slice(positions.get(id) + 1, positions.get(id) + 1 + FOLLOW)) ids.add(row.event_id);
  const agents = new Set(all.filter(row => ids.has(row.event_id)).map(row => row.event_by));
  const verdictRows = db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all().filter(row => items.has(row.item_id));
  for (const row of verdictRows) agents.add(row.verdict_by);
  for (const row of all) if (AGENT_KINDS.includes(row.event_kind) && agents.has(row.event_by)) ids.add(row.event_id);
  const events = all.filter(row => ids.has(row.event_id));
  const shoutIds = new Set(events.filter(row => row.event_kind === 'shout').map(row => detailOf(row.event_detail).shout).filter(id => id != null));
  const shout = db.prepare('SELECT shout_id, shout_to, shout_text, shout_decision FROM shout WHERE shout_id=?');
  const records = readVerifyRecords(board, { since, only });
  return {
    since,
    verdicts: verdictEvents.map(row => row.event_id),
    agents: db.prepare('SELECT agent_id, agent_route FROM agent ORDER BY agent_id').all().filter(row => agents.has(row.agent_id)).map(row => [row.agent_id, row.agent_route]),
    items: db.prepare('SELECT item_id, item_frozen, item_frozen_digest, item_lane FROM item ORDER BY item_id').all().filter(row => items.has(row.item_id))
      .map(row => [row.item_id, row.item_frozen, row.item_frozen_digest, row.item_lane]),
    events: events.map(row => [row.event_id, row.event_at, row.event_by, row.event_kind, row.item_id, row.event_detail]),
    shouts: [...shoutIds].sort((a, b) => a - b).map(id => shout.get(id)).filter(Boolean).map(row => [row.shout_id, row.shout_to, row.shout_text, row.shout_decision]),
    verdictRows: verdictRows.map(row => [row.verdict_id, row.item_id, row.verdict_by, row.verdict_decision, row.verdict_reason, row.verdict_note, row.verdict_commit,
      row.verdict_digest, row.verdict_head, row.verdict_verifier_family ?? null, row.verdict_at]),
    meta: db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'outside_source:%' OR meta_key = 'line_setting:bar.sharpenToPerson' ORDER BY meta_key").all()
      .filter(row => !row.meta_key.startsWith('outside_source:') || items.has(Number(row.meta_key.split(':')[1]))).map(row => [row.meta_key, row.meta_value]),
    decisions: records.verify.map(record => ({ table: 'verify', event: record.event.id, landing: recordLanding(record) })),
    unreplayable: records.unreplayable,
  };
}
