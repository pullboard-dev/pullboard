/** Rebuild every recorded release from a board, read-only, as replay records for the release and reclaim tables [C7,#8240]. */
import { openBoardReadOnly } from '../../../../store/index.js';

const KINDS = Object.freeze(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'withdraw', 'merged', 'reopen', 'escalate', 'unhold_item', 'hold_item', 'submit-handoff', 'reserve']);
const LIFECYCLE = Object.freeze(['claim', 'release', 'submit', 'withdraw', 'merged', 'reopen']);
const FAR = '2099-01-01T00:00:00.000Z';

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** As the board stores it, without the actor's model, which the event writer stamps on every event and no move decides. */
const stored = ({ model, ...rest }) => JSON.parse(JSON.stringify(rest));

/** The item's route and hold as they stood before an event, rebuilt from its own history. */
function itemBefore(before) {
  let route = before.find(e => e.kind === 'add')?.detail.route ?? null;
  let hold = null;
  for (const e of before) {
    if (e.kind === 'escalate') route = e.detail.to ?? route;
    if (e.kind === 'edit' && typeof e.detail.route === 'string') route = e.detail.route;
    if (e.kind === 'edit' && e.detail.fields?.item_route) route = e.detail.fields.item_route;
    if (e.kind === 'hold_item') hold = e.detail.reason ?? 'held';
    if (e.kind === 'unhold_item') hold = null;
  }
  return { route, hold };
}

/**
 * Read every release recorded since `since`, each rebuilt as a replay record for the table that decides it.
 * A record's `recorded.events` is what the board wrote in the release's own transaction: a progress return's note, the release,
 * then the coordinator's automatic escalation or hold. Paths the tables do not model, or whose inputs history cannot rebuild, are listed with why.
 * Why: a table is trusted only once it reproduces what the board really decided, release by release.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string, only?: number[] }} options - ISO time; releases at or after it are read. `only` keeps just the release event ids it names.
 * @returns {{ release: object[], reclaim: object[], unreplayable: { event: number, path: string }[] }}
 */
export function readReleaseRecords(board, { since, only }) {
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    return rebuild(opened ?? board.db, since, only ? new Set(only) : null);
  } finally {
    if (opened) opened.close();
  }
}

/** The rebuild itself, over an open connection. */
function rebuild(db, since, only) {
  const routes = Object.fromEntries(db.prepare('SELECT agent_id, agent_route FROM agent').all().map(a => [a.agent_id, a.agent_route]));
  const itemEvents = db.prepare(`SELECT event_id id, event_at at, event_kind kind, event_by by, event_detail d FROM event WHERE item_id=? AND event_kind IN (${KINDS.map(() => '?').join(',')}) ORDER BY event_id`);
  const near = db.prepare('SELECT event_id id, event_kind kind, event_by by, item_id item, event_detail d FROM event WHERE event_id>? AND event_id<? ORDER BY event_id');
  const releases = db.prepare("SELECT event_id, event_at, item_id, event_by, event_detail FROM event WHERE event_kind='release' AND event_at>=? ORDER BY event_id").all(since);
  const out = { release: [], reclaim: [], unreplayable: [] };
  const skip = (r, path) => out.unreplayable.push({ event: r.event_id, path });

  /** The events the board wrote in the release's transaction, in order. */
  const written = (r, detail) => {
    const around = near.all(r.event_id - 2, r.event_id + 5).map(e => ({ ...e, detail: detailOf(e.d) }));
    const prior = around.filter(e => e.id < r.event_id).at(-1);
    const head = prior && prior.item === r.item_id && prior.kind === 'fact' && prior.by === 'board' && String(prior.detail.id ?? '').startsWith('progress-return-') ? [prior] : [];
    const tail = [];
    for (const e of around.filter(x => x.id > r.event_id)) {
      if (e.item !== r.item_id || e.by !== 'coordinator') break;
      if (e.kind === 'escalate' || (e.kind === 'hold_item' && e.detail.automatic === 'release-twice')) tail.push(e);
      else break;
    }
    return [...head, { kind: 'release', by: r.event_by, detail }, ...tail].map(e => ({ kind: e.kind, by: e.by, detail: stored(e.detail) }));
  };
  /** A release record's snapshot also carries the engine its release was written at (null when an older engine recorded none), so the table can tell engines apart; no rule reads it yet [#9831]. */
  const withEngine = (table, snapshot, detail) => (table === 'release' ? { ...snapshot, engine: detail.engine ?? null } : snapshot);
  const push = (table, r, snapshot, move, detail) => out[table].push({ event: { id: r.event_id, at: r.event_at }, snapshot: withEngine(table, snapshot, detail), move, recorded: { events: written(r, detail) } });

  for (const r of releases) {
    if (only && !only.has(r.event_id)) continue;
    const detail = detailOf(r.event_detail);
    const before = itemEvents.all(r.item_id, ...KINDS).map(e => ({ id: e.id, at: e.at, kind: e.kind, by: e.by, detail: detailOf(e.d) })).filter(e => e.id < r.event_id);
    if (reclaimRecord(r, detail, push, skip)) continue;
    releaseRecord(r, detail, before, routes, { push, skip, written });
  }
  return out;
}

/** Push the reclaim record for a maintenance release; true when the release was maintenance. */
function reclaimRecord(r, detail, push, skip) {
  if (detail.idleClaim) {
    const c = detail.idleClaim, observed = Date.parse(c.observedAt);
    const row = { id: r.item_id, actor: c.holder, idle: c.kind, claimEventId: c.claimEventId, workActivity: c.lastActivity ?? undefined, handoff: c.handoff, waitingOn: c.waitingOn };
    if (c.kind === 'seat-gone') {
      row.deadSeat = { observedAt: c.observedAt, quietMs: 120_000, heartbeatAt: detail.reclaim?.heartbeatAt ?? null, worktreeMissing: detail.reclaim?.worktreeMissing };
      if (!row.deadSeat.heartbeatAt) row.claimAt = new Date(observed - 180_000).toISOString();
    }
    if (c.kind === 'release' || c.kind === 'dependency') row.idleMs = observed - Date.parse(c.lastActivity);
    // A stranded dependency's waiters and quiet resources are observed off the board; the recorded release stands for them.
    if (c.kind === 'dependency') Object.assign(row, { resourceQuiet: true, dependents: ['observed'] });
    if (c.kind === 'progress') {
      const words = /^Returned after (.+?); holder \S+'s notes: (.*) \(pullboard show \d+ --detail\); /su.exec(detail.reason ?? '');
      if (!words) { skip(r, 'reclaim progress: trigger not recorded'); return true; }
      row.progress = { trigger: words[1], notes: words[2] === 'none recorded' ? [] : words[2].split(', ') };
    }
    // Whether the item was pinned is not recorded; a pinned item lapses at 30 minutes instead of 40.
    const snapshot = { item: { id: r.item_id, status: 'claimed', owner: c.holder, after: c.waitingOn ?? [] }, ownerLastClaimId: c.claimEventId,
      deps: Object.fromEntries((c.waitingOn ?? []).map(id => [id, { status: 'open', merged: false }])), redReturnLease: false, progressNow: row.progress ?? null,
      pinned: c.kind === 'release' && row.idleMs < 40 * 60_000,
      ...(c.kind === 'dependency' ? { waiters: ['observed'], lastWork: c.lastActivity } : {}) };
    // The configured dependency limit is not recorded; the idle time it passed reproduces the decision.
    const limits = c.kind === 'dependency' ? { dependency: row.idleMs } : undefined;
    push('reclaim', r, snapshot, { kind: 'idle', maintainer: r.event_by, observedAt: c.observedAt, row, limits, now: r.event_at }, detail);
    return true;
  }
  if (detail.expiredClaim && !detail.staleClaim) {
    const x = detail.expiredClaim;
    const leaseMs = Date.parse(detail.reopenFirstRefusal?.until) - Date.parse(r.event_at);
    const leaseStartedAt = new Date(Date.parse(x.leaseUntil) - leaseMs).toISOString();
    // The configured limit is not recorded; any limit both intervals passed reproduces the decision.
    const limit = Math.min(Date.parse(x.observedAt) - Date.parse(x.leaseUntil), Date.parse(x.observedAt) - Date.parse(x.lastActivity));
    const row = { id: r.item_id, actor: x.holder, leaseUntil: x.leaseUntil, leaseEventId: x.leaseEventId, leaseStartedAt, leaseMs, lastActivity: x.lastActivity, evidence: { complete: true }, limitMs: limit };
    const snapshot = { item: { id: r.item_id, status: 'claimed', owner: x.holder, leaseUntil: x.leaseUntil }, ownerLastLease: { id: x.leaseEventId, at: leaseStartedAt, leaseUntil: x.leaseUntil } };
    push('reclaim', r, snapshot, { kind: 'lapsed-claim', maintainer: r.event_by, observedAt: x.observedAt, limits: { claim: limit }, row, now: r.event_at }, detail);
    return true;
  }
  if (detail.review && detail.stale) {
    const st = detail.stale;
    const row = { reviewer: st.reviewer, commit: 'c', reviewUntil: 'u', reserveEventId: 1, reservedAt: st.reservedAt, sourceSubmitEventId: 2, lastActivity: st.lastActivity, evidence: { complete: true }, limitMs: 1_800_000 };
    const snapshot = { item: { status: 'submitted', reviewer: st.reviewer, commit: 'c', reviewUntil: 'u' }, reserve: { id: 1, at: st.reservedAt }, lastSubmitId: 2 };
    push('reclaim', r, snapshot, { kind: 'review-idle', maintainer: r.event_by, observedAt: new Date(Date.parse(st.lastActivity) + 1_800_000).toISOString(), limits: { review: 1_800_000 }, row, now: r.event_at }, detail);
    return true;
  }
  if (detail.review && detail.lapsed) {
    const snapshot = { item: { status: 'submitted', reviewer: detail.lapsed.reviewer, reviewUntil: new Date(Date.parse(r.event_at) + 60_000).toISOString() } };
    // The reviewer's last heartbeat is off the board; when the wording names it, its minutes stand in for it.
    const minutes = /^Review silent for (\d+) minutes; its reservation lease lapsed\.$/u.exec(detail.reason ?? '');
    const seenAt = minutes ? new Date(Date.parse(r.event_at) - Number(minutes[1]) * 60_000).toISOString() : null;
    push('reclaim', r, snapshot, { kind: 'review-lapse', lapse: detail.lapsed, now: r.event_at, seenAt }, detail);
    return true;
  }
  return false;
}

/** Push the release-table record for a release the command wrote, or list why it cannot be rebuilt. */
function releaseRecord(r, detail, before, routes, { push, skip, written }) {
  if (detail.goneSeat || detail.exitHandoff) return skip(r, 'release: a path never used on a real board');
  const it = itemBefore(before);
  if (!it.route) return skip(r, 'release: route unknown');
  const lastClaim = before.filter(e => e.kind === 'claim').at(-1) ?? null;
  const escalated = written(r, detail).find(e => e.kind === 'escalate');
  if (escalated && escalated.detail.from !== it.route) return skip(r, 'release: the item route changed off the record');
  // #2956 stopped a structured-blocker release counting toward release-twice; one recorded before then followed up on it.
  if (detail.blockedOn?.length && written(r, detail).some(e => e.kind === 'escalate' || e.kind === 'hold_item')) return skip(r, 'release: counted a structured blocker, which no longer counts');
  const base = { item: { id: r.item_id, status: 'claimed', owner: r.event_by, route: it.route, after: [], leaseUntil: FAR, holdReason: it.hold, holdBy: it.hold ? 'coordinator' : null, reviewer: null },
    actor: { id: r.event_by, route: routes[r.event_by] ?? null, path: '/seat' }, owner: null, diagnosed: true, firstRefusalBuilder: null,
    items: { [r.item_id]: { status: 'claimed', after: [] }, ...Object.fromEntries((detail.blockedOn ?? []).map(id => [id, { status: 'open', after: [] }])) },
    history: before, lastClaim, revision: 1, ownerLastClaimId: lastClaim?.id ?? null, ownerLastLease: null, ownerRegisteredPath: '/seat' };
  const note = detail.reason ?? '';
  if (detail.staleClaim) {
    const sc = detail.staleClaim, lapsed = Boolean(detail.expiredClaim);
    const leaseUntil = lapsed ? detail.expiredClaim.leaseUntil : FAR;
    const leaseMs = lapsed ? Date.parse(detail.reopenFirstRefusal.until) - Date.parse(r.event_at) : 1;
    const leaseAt = new Date(Date.parse(leaseUntil) - leaseMs).toISOString();
    const row = { id: r.item_id, actor: sc.holder, leaseUntil, claimEventId: sc.claimEventId, lastActivity: sc.lastActivity, evidence: { complete: true }, limitMs: sc.limitMs, blocker: sc.blocker,
      leaseEventId: lapsed ? detail.expiredClaim.leaseEventId : 1, leaseStartedAt: leaseAt, leaseMs, ...(sc.seatFolderMissing ? { seatFolderMissing: sc.seatFolderMissing } : {}) };
    const snapshot = { ...base, item: { ...base.item, owner: sc.holder, leaseUntil }, ownerLastClaimId: sc.claimEventId, ownerRegisteredPath: sc.seatFolderMissing ?? '/seat',
      ownerLastLease: { id: row.leaseEventId, at: leaseAt, leaseUntil } };
    const staleNote = sc.seatFolderMissing ? sc.reason.replace(/^registered worktree no longer exists: .*?; /u, '') : sc.reason;
    return push('release', r, snapshot, { id: r.item_id, actor: r.event_by, root: '/c', reason: detail.reasonCode, note: staleNote, now: r.event_at,
      stale: { staleClaim: row, observedAt: sc.observedAt, observedRevision: 1, leaseLapse: lapsed, health: { stuck: `${sc.limitMs / 60_000}m` } } }, detail);
  }
  if (detail.review) {
    const snapshot = { ...base, item: { ...base.item, status: 'submitted', owner: 'someone', reviewer: r.event_by } };
    return push('release', r, snapshot, { id: r.item_id, actor: r.event_by, root: '/seat', reason: detail.reasonCode, note, now: r.event_at }, detail);
  }
  if (!detail.reasonCode) return skip(r, 'release: no reason code (an older engine)');
  const last = before.filter(e => LIFECYCLE.includes(e.kind)).at(-1);
  if (last?.kind !== 'claim' || last.by !== r.event_by) return skip(r, 'release: holder unclear from history');
  const snapshotOfTree = detail.untouchedAutoClaim ? lastClaim?.detail?.autoNextSnapshot : { head: 'moved', digest: 'moved' };
  if (detail.untouchedAutoClaim && !snapshotOfTree) return skip(r, 'release: untouched auto-claim with no recorded worktree snapshot');
  if (['OTHER', 'DIAGNOSIS_WRONG'].includes(detail.reasonCode) && !note) return skip(r, 'release: a noted reason with no recorded note');
  return push('release', r, base, { id: r.item_id, actor: r.event_by, root: '/seat', reason: detail.reasonCode, note, on: detail.blockedOn, now: r.event_at, worktreeSnapshot: snapshotOfTree }, detail);
}
