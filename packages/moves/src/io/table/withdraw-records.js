/** Rebuild every recorded withdraw and reopen from a board, read-only, as replay records for their tables [C7,#8258]. */
import { openBoardReadOnly } from '../../../../store/index.js';

const KINDS = Object.freeze(['add', 'claim', 'release', 'submit', 'accept', 'merge-only-accept', 'merged', 'reopen', 'withdraw']);
const STATUS = Object.freeze({ add: 'open', claim: 'claimed', submit: 'submitted', accept: 'verified', 'merge-only-accept': 'verified', merged: 'merged', reopen: 'open', withdraw: 'withdrawn' });

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** The detail keys a reopen table decides; the derived cause, reservation and pipeline fields belong to the shell. */
const DECIDED = Object.freeze(['commit', 'note', 'judgment', 'supersedes', 'landingFailure', 'conflict']);
const decided = (detail) => Object.fromEntries(DECIDED.filter((key) => detail[key] !== undefined).map((key) => [key, detail[key]]));

/** The item's status as it stood before an event, rebuilt from its own lifecycle history; a review release leaves a submission submitted. */
function statusBefore(before) {
  let status = 'open';
  for (const e of before) {
    if (e.kind === 'release') status = e.detail.review ? status : 'open';
    else if (STATUS[e.kind]) status = STATUS[e.kind];
  }
  return status;
}

/**
 * Read every withdraw and reopen recorded since `since`, each rebuilt as a replay record for the table that decides it.
 * A record's `recorded.events` is what the table decides: the withdraw event, or the reopen event's decided keys.
 * Paths whose inputs history cannot rebuild are listed with why. `only` keeps just the event ids it names.
 * Why: a table is trusted only once it reproduces what the board really decided, move by move.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string, only?: number[] }} options
 * @returns {{ withdraw: object[], reopen: object[], unreplayable: { event: number, path: string }[] }}
 */
export function readWithdrawRecords(board, { since, only }) {
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    return rebuild(opened ?? board.db, since, only ? new Set(only) : null);
  } finally {
    if (opened) opened.close();
  }
}

/** The rebuild itself, over an open connection. */
function rebuild(db, since, only) {
  const itemEvents = db.prepare(`SELECT event_id id, event_at at, event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${KINDS.map(() => '?').join(',')}) ORDER BY event_id`);
  const moves = db.prepare("SELECT event_id, event_at, item_id, event_by, event_kind, event_detail FROM event WHERE event_kind IN ('withdraw','reopen') AND event_at>=? ORDER BY event_id").all(since);
  const nextEvent = db.prepare('SELECT event_detail d FROM event WHERE event_id=?');
  const out = { withdraw: [], reopen: [], unreplayable: [] };
  for (const r of moves) {
    if (only && !only.has(r.event_id)) continue;
    const detail = detailOf(r.event_detail);
    const before = itemEvents.all(r.item_id, ...KINDS).map((e) => ({ id: e.id, kind: e.kind, detail: detailOf(e.d) })).filter((e) => e.id < r.event_id);
    const status = statusBefore(before);
    const stamp = { id: r.event_id, at: r.event_at };
    const skip = (path) => out.unreplayable.push({ event: r.event_id, path });
    if (r.event_kind === 'withdraw') {
      const next = nextEvent.get(r.event_id + 1);
      if (detailOf(next?.d).kind === 'measurement' && /^Fixed on main by /u.test(detailOf(next?.d).text ?? '')) { skip('withdraw: a Main red audit whose frozen item is not recorded'); continue; }
      out.withdraw.push({ event: stamp, snapshot: { actor: { id: r.event_by, joined: true }, item: { id: r.item_id, status } },
        move: { id: r.item_id, actor: r.event_by, reason: detail.reason }, recorded: { events: [{ kind: 'withdraw', by: r.event_by, detail: { reason: detail.reason } }] } });
      continue;
    }
    if (detail.sourceAdvanceReturn || (r.event_by !== 'coordinator' && !detail.withdrawnVerdict)) { skip('reopen: an autonomous or agent-granted return, whose authority is read off the board'); continue; }
    if (!['submitted', 'verified'].includes(status)) { skip('reopen: the item status before cannot be rebuilt'); continue; }
    const withdrawing = Boolean(detail.withdrawnVerdict);
    const snapshot = { actor: { id: r.event_by, joined: true }, item: { id: r.item_id, status, commit: detail.commit, mergedCommit: null },
      landing: detail.landingFailure ? { accepted: detail.supersedes, failure: detail.landingFailure } : {},
      conflict: detail.conflict ? { accepted: true, supersedes: detail.supersedes } : {}, ...(withdrawing ? { withdrawal: { acceptEventId: detail.supersedes } } : {}) };
    const move = { id: r.item_id, actor: r.event_by, note: detail.note, cause: detail.cause, ...(detail.conflict ? { conflict: detail.conflict, conflictNote: detail.note } : {}), ...(withdrawing ? { withdrawVerdict: true } : {}) };
    out.reopen.push({ event: stamp, snapshot, move, recorded: { events: [{ kind: 'reopen', by: r.event_by, detail: decided(detail) }] } });
  }
  return out;
}
