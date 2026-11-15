/** Read the landing lease events a board recorded, read-only, and replay the lease table over them [C7,#8164]. */
import { Refused } from '../../../../kernel/light.js';
import { openBoardReadOnly } from '../../../../store/index.js';
import { leaseEngine } from '../../logic/table/lease.table.js';
import { replayTable } from '../../logic/table/replay.js';

/** The 120 s lease the store records under; replay builds its table over the same rule, passed in by the caller when it differs. */
const DEFAULT_LEASE_MS = 120_000;

/** An entry the log can rebuild: a token, a label, a process and dates, which is all the table's own check needs. */
const entryValid = (entry) => typeof entry?.token === 'string' && entry.token.length > 0 && typeof entry.label === 'string' && entry.label.length > 0
  && Number.isSafeInteger(entry.pid) && Number.isFinite(Date.parse(entry.until)) && Number.isFinite(Date.parse(entry.since));

/** A recorded detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** The eight characters a holder's label ends with, which are the front of its token. */
const labelPrefix = (label) => /landing ([a-f0-9]{8})$/u.exec(label ?? '')?.[1] ?? null;
const labelBase = (label) => (typeof label === 'string' ? label.replace(/ landing [a-f0-9]{8}$/u, '') : null);

/**
 * Read every recorded landing lease move since a time, each with the queue it saw, in event order.
 * The log keeps the outcome of each move (generation, holder label, queue length) but not the clock or the other entries, so the queue before each move is rebuilt from the log
 * and its clock is read from the outcome: a holder replaced with no release between is read as expired at that move, so are the queued entries the new holder passed, and every other entry as live.
 * Why: that is the one fact the board never wrote down; every other field of the answer is checked against what the board recorded.
 *
 * @param {string | { db: { prepare: Function } }} board - A board file path, or an open board that is only SELECTed.
 * @param {{ since: string | number, leaseMs?: number }} options
 * @returns {{ event: { id: number, at: string }, snapshot: object, move: object, recorded: { events: object[] } }[]}
 */
export function readLandingRecords(board, { since, leaseMs = DEFAULT_LEASE_MS } = {}) {
  const from = new Date(typeof since === 'number' ? since : Date.parse(since));
  if (Number.isNaN(from.getTime())) throw new Refused('READ_SINCE', 'reading recorded landing moves needs a time, and got none that parses', 'pass { since } as ISO text or epoch milliseconds');
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    const rows = (opened ?? board.db).prepare("SELECT event_id, event_at, event_detail FROM event WHERE event_kind = 'landing_lease' ORDER BY event_id").all();
    const records = [];
    let lease = { generation: 0, holder: null, line: [] };
    let base = 'coordinator';
    for (const row of rows) {
      const detail = detailOf(row.event_detail);
      const now = Date.parse(row.event_at);
      const token = String(detail.token ?? '');
      const holderNow = labelPrefix(detail.holder);
      const turnover = detail.action === 'request' && holderNow && holderNow !== lease.holder?.token.slice(0, 8);
      const replaced = Boolean(turnover && lease.holder);
      const place = lease.line.findIndex(entry => entry.token.startsWith(holderNow ?? '-'));
      const passed = turnover ? lease.line.slice(0, place < 0 ? lease.line.length : place) : [];
      const alive = (entry, lapsedNow) => ({ ...entry, until: new Date(lapsedNow ? now - 1 : now + leaseMs).toISOString() });
      const before = { generation: lease.generation, holder: lease.holder && alive(lease.holder, replaced), line: lease.line.map(entry => alive(entry, passed.includes(entry))) };
      base = labelBase(detail.holder) ?? base;
      if (row.event_at >= from.toISOString()) {
        records.push({
          event: { id: row.event_id, at: row.event_at },
          snapshot: { lease: before, now, lineage: null, modern: false, shared: true, legacyShared: false, heartbeat: null },
          move: { name: detail.action, token, generation: before.holder?.token === token ? before.holder.generation : detail.generation, branch: 'trunk', pid: 1, label: base, lineage: null },
          recorded: { events: [{ kind: 'landing_lease', action: detail.action, token, holder: detail.holder ?? null, generation: detail.generation, queued: detail.queued }] },
        });
      }
      lease = next(lease, detail, token, now, base);
    }
    return records;
  } finally {
    if (opened) opened.close();
  }
}

/** The queue after a recorded move, rebuilt from what the log says it left: the generation, who holds, and how many wait. */
function next(lease, detail, token, now, base) {
  const prefix = labelPrefix(detail.holder);
  const known = [lease.holder, ...lease.line].filter(Boolean);
  const entry = (who) => ({ token: who, branch: 'trunk', pid: 1, label: `${base} landing ${who.slice(0, 8)}`, lineage: null, since: new Date(now).toISOString(), until: new Date(now).toISOString() });
  let holder = null;
  if (prefix) holder = known.find(candidate => candidate.token.startsWith(prefix)) ?? (token.startsWith(prefix) ? entry(token) : null);
  if (holder) holder = { ...holder, generation: detail.generation, label: detail.holder };
  const waiting = [...known, ...(detail.action === 'request' && !known.some(candidate => candidate.token === token) ? [entry(token)] : [])]
    .filter(candidate => candidate.token !== holder?.token && !(detail.action === 'release' && candidate.token === token));
  return { generation: detail.generation, holder, line: Number.isSafeInteger(detail.queued) ? waiting.slice(Math.max(0, waiting.length - detail.queued)) : waiting };
}

/**
 * Replay the lease table over the landing moves a board recorded since a time, and list every disagreement with what the board wrote.
 * Why: the lease table is trusted only once it reproduces the board's own admission log.
 *
 * @param {string | { db: { prepare: Function } }} board
 * @param {{ since: string | number, leaseMs?: number }} options
 * @returns {ReturnType<typeof replayTable>}
 */
export function replayLandingMoves(board, { since, leaseMs = DEFAULT_LEASE_MS } = {}) {
  const { rules, table } = leaseEngine({ leaseMs, valid: entryValid });
  return replayTable(table, rules, readLandingRecords(board, { since, leaseMs }), { cut: since });
}
