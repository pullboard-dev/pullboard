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
/** The item event kinds the verify fold applies; any other item row before a verdict cannot change it. */
const VERIFY_KINDS = Object.freeze(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'escalate', 'hold_item', 'unhold_item',
  'refreeze', 'reserve', 'bar-sharpen', 'strong-rejection-notice', 'fact', 'submit_handoff_returned']);
/** The detail fields the verify fold and table read from an item's earlier rows, by kind; a fixture keeps only these. Kinds not named here are kept whole. */
const VERIFY_FIELDS = Object.freeze({
  add: ['route', 'lane'], edit: ['route', 'correctedFrozen', 'unfrozen', 'machineVerification', 'expiredHolder'], claim: ['digest'], renew: ['digest'], release: ['review', 'reasonCode'],
  submit: ['commit'], reserve: ['until'], fact: ['kind'], refreeze: ['after', 'retainedClaim', 'unchanged'], reopen: [], withdraw: [], merged: [], unhold_item: [], submit_handoff_returned: [],
});
/** The follow-up kinds a verdict's recorded writes copy whole. */
const FOLLOW_KINDS = Object.freeze(['shout', 'fact', 'hold_item', 'bar-sharpen', 'escalate', 'strong-rejection-notice']);
/** The detail fields the landing fold reads, by event kind; a fixture keeps only these. */
const LANDING_FIELDS = Object.freeze({
  add: ['after'], edit: ['after', 'expiredHolder'], claim: [], release: ['review', 'blockedOn'], refreeze: ['retainedClaim', 'unchanged'], submit: ['commit'],
  accept: ['commit', 'review'], reject: [], reopen: [], withdraw: ['reason'], merged: ['commit', 'forced', 'reason', 'from'], reland: ['commit'], 'merge-only-accept': ['commit'],
  hold_item: ['reason'], unhold_item: [], landing_batch: ['batch'], landing_lease: ['action', 'holder', 'token', 'generation'], landing_waiver: ['waiver'],
  'main-moved': ['sha', 'batch', 'items'],
});
/** The batch fields the landing fold and the landing table read; a fixture keeps only these (failures are cut to their file). */
const BATCH_FIELDS = Object.freeze(['id', 'state', 'base', 'tip', 'startedAt', 'adoptedFrom', 'candidates', 'items', 'blocked', 'refusal', 'refusals', 'culprits', 'dropped', 'supersededByMain']);
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
 * @param {{ since: string, merged?: number[], verdicts?: number[], fixture?: boolean, home?: string }} options - ISO cut; `merged` and `verdicts` sample event ids as the readers' `only` does;
 *   `fixture` keeps only the rows and fields a decision reads, and renames landing lease tokens.
 * @returns {{ landing: object, verify: object }}
 */
export function exportTableHistory(board, { since, merged, verdicts, fixture = false, home = homedir() }) {
  if (!Number.isFinite(Date.parse(since))) throw new Refused('READ_SINCE', 'exporting recorded history needs a time, and got none that parses', 'pass { since } as ISO text');
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    const source = opened ? { db: opened } : board;
    return scrubHome({ landing: landingDocument(source, since, merged, fixture), verify: verifyDocument(source, since, verdicts, fixture) }, home);
  } finally {
    if (opened) opened.close();
  }
}

/** The landing document: the rows the landing reader folds and one decision per rebuilt record. */
function landingDocument(board, since, merged, fixture) {
  const rows = board.db.prepare(`SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event WHERE event_kind IN (${LANDING_KINDS.map(() => '?').join(',')}) ORDER BY event_id`)
    .all(...LANDING_KINDS);
  const records = readLandingMoveRecords(board, { since, only: merged });
  const decisions = LANDING_TABLES.flatMap(table => records[table].map(record => ({ table, event: record.event.id, landing: recordLanding(record) })));
  const kept = fixture ? fixtureRows(rows, records, since) : rows;
  return {
    since,
    merged: merged ?? records.merged.map(record => record.event.id),
    events: fixture ? fixtureEvents(kept) : kept.map(row => [row.event_id, row.event_at, row.event_by, row.event_kind, row.item_id, detailOf(row.event_detail)]),
    decisions,
    unreplayable: records.unreplayable,
  };
}

/** A detail cut to the fields the landing fold reads for its kind; a batch is cut to the fields the fold and the landing table read. */
function project(kind, detail) {
  return Object.fromEntries((LANDING_FIELDS[kind] ?? []).filter(field => detail[field] !== undefined)
    .map(field => [field, field === 'review' && detail.review && typeof detail.review === 'object' ? { head: detail.review.head }
      : field === 'batch' && detail.batch && typeof detail.batch === 'object' ? projectBatch(detail.batch) : detail[field]]));
}

/**
 * A batch cut to the fields the landing fold and the landing table read, with each failure cut to its file.
 * Why: a recorded batch carries its whole gate output (parallel candidates, logs, ratchets), which no decision reads and which is most of a board's landing log.
 */
function projectBatch(batch) {
  const kept = Object.fromEntries(BATCH_FIELDS.filter(field => batch[field] !== undefined).map(field => [field, batch[field]]));
  if (Array.isArray(batch.failures)) kept.failures = batch.failures.map(failure => (failure && typeof failure === 'object' && failure.file ? { file: failure.file } : {}));
  return kept;
}

/**
 * The fixture's event rows, each detail projected and each lease token renamed t1, t2, ..., with a batch revision dropped when it repeats its batch's previous kept revision field for field.
 * Why: a batch is rewritten on every gate step; the fold keeps only the latest revision per id and reads a change only in its refusal or culprits, so a repeat decides nothing.
 */
function fixtureEvents(rows) {
  const last = new Map();
  const tokens = new Map();
  const events = [];
  for (const row of rows) {
    const detail = project(row.event_kind, detailOf(row.event_detail));
    // A lease token is only ever compared for equality, so a short stand-in per distinct token decides the same and reads as no credential.
    if (row.event_kind === 'landing_lease' && detail.token != null) {
      if (!tokens.has(detail.token)) tokens.set(detail.token, `t${tokens.size + 1}`);
      detail.token = tokens.get(detail.token);
    }
    if (row.event_kind === 'landing_batch' && detail.batch?.id !== undefined) {
      const text = JSON.stringify(detail.batch);
      if (last.get(detail.batch.id) === text) continue;
      last.set(detail.batch.id, text);
    }
    events.push([row.event_id, row.event_at, row.event_by, row.event_kind, row.item_id, detail]);
  }
  return events;
}

/**
 * The rows a replay fixture keeps: every row of an item some decision in the window reads, and the itemless landing rows from the first batch the window decides on.
 * Why: a whole board's landing log is far too large to commit, and a decision reads only these.
 */
function fixtureRows(rows, records, since) {
  const items = new Set();
  const take = (id) => { if (id != null) items.add(Number(id)); };
  for (const table of LANDING_TABLES) {
    for (const record of records[table]) {
      const { item, items: many, batch } = record.snapshot ?? {};
      take(item?.id);
      for (const id of Object.keys(many ?? {})) take(id);
      for (const entry of [...(batch?.candidates ?? []), ...(batch?.items ?? [])]) take(entry.id);
      if (table === 'select') take(record.move?.id);
    }
  }
  const starts = LANDING_TABLES.flatMap(table => records[table]).map(record => record.snapshot?.batch?.startedAt ?? record.snapshot?.now).filter(Boolean);
  const from = [since, ...starts].sort()[0];
  return rows.filter(row => (row.item_id == null ? row.event_at >= from : items.has(row.item_id)));
}

/**
 * Cut the verify rows to what a rebuilt verdict reads: each item's fold rows up to its last verdict in the window, the follow-up rows after each verdict whole,
 * and only the verdict actors' agent rows, route changes and verify-kind flake observations. `ids` and `agents` are cut in place; the follow-up row ids are returned.
 * Why: the items' whole later lives, every toucher's flake log and gate output are most of a board's verify export, and no verdict reads them.
 */
function cutVerifyRows(all, ids, verdictEvents, agents) {
  const verdicts = new Set(verdictEvents.map(row => row.event_id));
  const last = new Map(verdictEvents.map(row => [row.item_id, row.event_id]));
  const actors = new Set(all.filter(row => verdicts.has(row.event_id)).map(row => row.event_by));
  const positions = new Map(all.map((row, index) => [row.event_id, index]));
  const follow = new Set(verdictEvents.flatMap(({ event_id: id }) => all.slice(positions.get(id) + 1, positions.get(id) + 1 + FOLLOW).map(row => row.event_id)));
  const read = (row) => follow.has(row.event_id)
    || (last.has(row.item_id) && row.event_id <= last.get(row.item_id) && VERIFY_KINDS.includes(row.event_kind))
    || (row.event_kind === 'join' && actors.has(row.event_by))
    // The verify table reads an actor's flake observations only for a recorded verify failure, so no other kind can derive a cause.
    || (row.event_kind === 'flake-observation' && actors.has(row.event_by) && detailOf(row.event_detail).observation?.kind === 'verify');
  for (const row of all) if (ids.has(row.event_id) && !read(row)) ids.delete(row.event_id);
  for (const agent of [...agents]) if (!actors.has(agent)) agents.delete(agent);
  return follow;
}

/**
 * A verify row with its detail cut to what a rebuilt verdict reads: a follow-up the verdict's writes copy stays whole, any other follow-up keeps no detail,
 * and an item's earlier row keeps the fields its kind names in VERIFY_FIELDS.
 * Why: a follow-up only holds its place in the eight rows after a verdict unless the verdict wrote it, and an earlier row's notes and leases decide nothing;
 * a landing lease row is only ever a follow-up here, so its token is cut with the rest of its detail.
 */
function projectVerify(row, follow) {
  if (follow.has(row.event_id) && (FOLLOW_KINDS.includes(row.event_kind) || AGENT_KINDS.includes(row.event_kind))) return row;
  if (follow.has(row.event_id) && !(row.item_id != null && VERIFY_KINDS.includes(row.event_kind))) return { ...row, event_detail: '{}' };
  const fields = VERIFY_FIELDS[row.event_kind];
  if (!fields) return row;
  const detail = detailOf(row.event_detail);
  return { ...row, event_detail: JSON.stringify(Object.fromEntries(fields.filter(field => detail[field] !== undefined).map(field => [field, detail[field]]))) };
}

/** The verify document: the items with a verdict in the window, their rows and follow-ups, and one decision per rebuilt verdict. */
function verifyDocument(board, since, only, fixture) {
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
  const follow = fixture ? cutVerifyRows(all, ids, verdictEvents, agents) : null;
  const kept = all.filter(row => ids.has(row.event_id));
  const events = fixture ? kept.map(row => projectVerify(row, follow)) : kept;
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
