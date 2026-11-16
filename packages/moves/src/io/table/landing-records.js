/** Rebuild the landing decisions a board recorded, read-only, as replay records for the landing tables [C7,#8249]. */
import { Refused } from '../../../../kernel/light.js';
import { openBoardReadOnly } from '../../../../store/index.js';

const KINDS = Object.freeze(['add', 'edit', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'hold_item', 'unhold_item', 'claim', 'release', 'refreeze',
  'merge-only-accept', 'reland', 'landing_batch', 'landing_lease', 'main-moved', 'landing_waiver']);
/** Codes selection decides from git, files or review projection; only a stale verdict can be handed to the table as an io answer. */
const IO_CODES = Object.freeze(['STACKED_UNVERIFIED', 'PUBLISH_RED_FILE', 'LAND_FILE_OVERLAP']);
const CODE_NAMES = Object.freeze({ STALE_REOPENED: 'STALE_VERDICT', REPEATED_RED_REOPENED: 'LAND_REPEATED_RED' });
const FAR = '9999-12-31T00:00:00.000Z';
const SAME_TRANSACTION = 50;
/** A park is written by the transaction that records the refusal, within a few event ids of it. */
const SAME_TRANSACTION_IDS = 3;

/** A recorded detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

const idsOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[ ,]+/u) : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
const key = (entry) => `${entry.id}@${entry.commit}${entry.reviewedCommit ? `>${entry.reviewedCommit}` : ''}`;

/**
 * The decided part of an automatic repeat hold's reason: its cause, base and commit. The landing worktree path and the refusal's wording the shell adds are io text, not decisions.
 * Why: the table decides which item is parked for which repeated cause; the shell words the notice.
 */
function decided(reason, item) {
  const text = String(reason ?? '');
  const end = text.indexOf('} ') + 1;
  try {
    const { kind, key: cause, base, commit } = JSON.parse(text.slice('landing-repeat-v1:'.length, end));
    return `landing-repeat-v1:${JSON.stringify({ kind, key: cause, base, commit })} landing parked #${item}`;
  } catch { return text; }
}

/**
 * Read every landing decision recorded since a time: what selection chose and set aside, each receipt finish, each merge, and each automatic repeat-park.
 * One forward fold over the log rebuilds every item, batch (latest revision per id), lease and waiver, so each record carries the snapshot the board decided on.
 * Decisions that need git, files or a review projection are listed as unreplayable with why, apart from a stale verdict, which the batch's own record names.
 * Why: a table is trusted only once it reproduces what the board really decided, decision by decision.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string, only?: number[] }} options - ISO time; decisions at or after it are read. `only` keeps merged events whose ids it names, so a fixture can sample the many forced merges.
 * @returns {{ select: object[], selection: object[], record: object[], merged: object[], outcome: object[], unreplayable: { event: number, path: string }[] }}
 */
export function readLandingMoveRecords(board, { since, only }) {
  if (!Number.isFinite(Date.parse(since))) throw new Refused('READ_SINCE', 'reading recorded landing decisions needs a time, and got none that parses', 'pass { since } as ISO text');
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    return fold(opened ?? board.db, since, only ? new Set(only) : null);
  } finally {
    if (opened) opened.close();
  }
}

/** The fold itself, over an open connection. */
function fold(db, since, only) {
  const rows = db.prepare(`SELECT event_id id, event_at at, event_kind kind, event_by by, item_id item, event_detail d FROM event WHERE event_kind IN (${KINDS.map(() => '?').join(',')}) ORDER BY event_id`).all(...KINDS);
  const out = { select: [], selection: [], record: [], merged: [], outcome: [], unreplayable: [] };
  const skip = (id, path) => out.unreplayable.push({ event: id, path });
  const items = {};
  const acceptOrder = {};
  const batches = new Map();
  const waivers = [];
  const preReopen = new Map();
  const statusBeforeWithdraw = {};
  const lastRevision = new Map();
  const firstSeen = new Set();
  let lease = { holder: null };
  let pendingMerged = [];
  let recordBefore = null;

  const applyItem = (e) => {
    const d = e.detail;
    let it = items[e.item];
    if (e.kind === 'add') it = items[e.item] = { id: e.item, status: 'open', commit: null, checked: null, mergedCommit: null, holdReason: null, after: idsOf(d.after) };
    if (!it) return;
    switch (e.kind) {
      case 'edit': if (Array.isArray(d.after)) it.after = idsOf(d.after); if (d.expiredHolder && it.status === 'claimed') it.status = 'open'; break;
      case 'claim': if (['open', 'claimed'].includes(it.status)) it.status = 'claimed'; break;
      case 'release': if (!d.review && it.status === 'claimed') it.status = 'open'; if (Array.isArray(d.blockedOn)) it.after = [...new Set([...it.after, ...idsOf(d.blockedOn)])]; break;
      case 'refreeze': if (!d.retainedClaim && !d.unchanged && it.status === 'claimed') it.status = 'open'; break;
      case 'submit': it.status = it.lastKind === 'merge-only-accept' ? 'verified' : 'submitted'; it.commit = d.commit ?? it.commit; it.checked = it.commit; break;
      case 'accept': it.status = 'verified'; acceptOrder[e.item] = e.id; it.checked = d.commit === it.commit ? (d.review?.head ?? it.commit) : it.commit; break;
      case 'merge-only-accept': it.status = 'verified'; it.commit = d.commit ?? it.commit; it.checked = it.commit; break;
      case 'reject': it.status = 'open'; break;
      case 'reopen': if (e.by === 'coordinator') preReopen.set(e.item, { ...it, after: [...it.after] }); it.status = 'open'; break;
      case 'withdraw': if (String(d.reason ?? '').startsWith('landed by hand at')) statusBeforeWithdraw[e.item] = { id: e.id, status: it.status }; it.status = 'withdrawn'; break;
      case 'merged': it.mergedCommit = d.commit; break;
      case 'reland': it.mergedCommit = null; it.status = 'verified'; it.commit = d.commit ?? it.commit; it.checked = it.commit; acceptOrder[e.item] = e.id; break;
      case 'hold_item': it.holdReason = d.reason ?? 'held'; break;
      case 'unhold_item': it.holdReason = null; break;
      default: break;
    }
    it.lastKind = e.kind;
  };

  /** The items a decision may read: every pending item, its dependencies and the ones the batch named, copied at this moment. */
  const itemsFor = (extra = []) => {
    const view = {};
    const take = (id, from = items) => { if (from[id] && !view[id]) view[id] = { ...from[id], after: [...from[id].after] }; };
    for (const it of Object.values(items)) if (it.status === 'verified' && !it.mergedCommit) take(it.id);
    for (const id of Object.keys(view)) for (const dep of view[id].after) take(dep);
    for (const id of extra) take(id);
    return view;
  };

  const selectionState = (batch) => {
    const view = itemsFor((batch.blocked ?? []).map(b => b.id));
    for (const entry of batch.blocked ?? []) if (CODE_NAMES[entry.code] && preReopen.has(entry.id)) view[entry.id] = { ...preReopen.get(entry.id) };
    return { now: batch.startedAt, base: batch.base, items: view, batches: [...batches.values()], waivers: [...waivers], unverified: [], collisionFree: false, acceptOrder: { ...acceptOrder }, io: {} };
  };

  const checkSelection = (batch, at, id) => {
    const recorded = (batch.blocked ?? []).map(b => ({ id: b.id, code: CODE_NAMES[b.code] ?? b.code }));
    const needsIo = recorded.filter(b => IO_CODES.includes(b.code));
    for (const b of needsIo) skip(id, `select: ${b.code} is decided from git or files`);
    const state = selectionState(batch);
    const stale = new Set(recorded.filter(b => b.code === 'STALE_VERDICT').map(b => b.id));
    const snapshotFor = (itemId) => ({ ...state, item: state.items[itemId], io: stale.has(itemId) ? { staleVerdict: { reason: 'stale' } } : {}, picked: { count: 0, touched: {} } });
    for (const c of batch.candidates) out.select.push({ event: { id, at }, snapshot: snapshotFor(c.id), move: { name: 'select', id: c.id },
      recorded: { events: [{ kind: 'candidate', item: c.id, detail: c }] } });
    for (const b of recorded.filter(x => !IO_CODES.includes(x.code))) out.select.push({ event: { id, at }, snapshot: snapshotFor(b.id), move: { name: 'select', id: b.id }, recorded: { refused: b.code } });
    out.selection.push({ event: { id, at }, snapshot: state, maximum: batch.candidates.length || 1, stale: [...stale],
      wantReady: batch.candidates.map(key), wantBlocked: recorded.filter(b => !IO_CODES.includes(b.code)).map(b => `${b.id}:${b.code}`).sort(), ioBlocked: needsIo.length });
  };

  const checkRecord = (mainMoved, merges, before) => {
    const batch = before.batch;
    if (!batch) { skip(mainMoved.id, 'record: the batch it names is not on the log'); return; }
    out.record.push({ event: { id: mainMoved.id, at: mainMoved.at },
      snapshot: { now: mainMoved.at, lease: { holder: lease.holder }, lineage: null, batch, items: before.items },
      move: { name: 'record', actor: mainMoved.by, id: batch.id, tip: mainMoved.detail.sha, fence: lease.holder },
      recorded: { events: [...merges.map(m => ({ kind: 'merged', item: m.item, by: m.by, detail: { commit: m.detail.commit } })),
        { kind: 'main-moved', item: null, by: mainMoved.by, detail: { sha: mainMoved.detail.sha, batch: mainMoved.detail.batch, items: mainMoved.detail.items } }] } });
  };

  const checkMerged = (e, index, before) => {
    if (only && !only.has(e.id)) return;
    const reason = e.detail.forced ? e.detail.reason : undefined;
    // The board names the status it read in a forced merge's `from`; an unforced merge reads the fold.
    const status = e.detail.forced ? e.detail.from : before.status;
    const withdraw = e.detail.forced && ['open', 'claimed', 'submitted'].includes(e.detail.from)
      ? rows.slice(Math.max(0, index - 3), index).filter(r => r.kind === 'withdraw' && r.item === e.item).at(-1) : null;
    const events = [...(withdraw ? [{ kind: 'withdraw', by: withdraw.by, detail: { reason: detailOf(withdraw.d).reason } }] : []),
      { kind: 'merged', by: e.by, detail: { commit: e.detail.commit, ...(e.detail.forced ? { forced: true, reason: e.detail.reason, from: e.detail.from } : {}) } }];
    out.merged.push({ event: { id: e.id, at: e.at }, snapshot: { item: { id: e.item, status } }, move: { name: 'merged', actor: e.by, commit: e.detail.commit, forced: reason }, recorded: { events } });
  };

  rows.forEach((row, index) => {
    const e = { ...row, detail: detailOf(row.d) };
    const inWindow = e.at >= since;
    if (e.kind === 'landing_batch') {
      const batch = e.detail.batch;
      if (!firstSeen.has(batch.id)) {
        firstSeen.add(batch.id);
        if (inWindow && !batch.adoptedFrom) checkSelection(batch, e.at, e.id);
      }
      batches.set(batch.id, batch);
      const prior = lastRevision.get(batch.id);
      lastRevision.set(batch.id, batch);
      const newRefusal = batch.refusal && batch.refusal.at !== prior?.refusal?.at;
      const newCulprit = (batch.culprits ?? []).length > (prior?.culprits ?? []).length;
      if (inWindow && (newRefusal || newCulprit)) {
        const entries = batch.candidates ?? batch.items ?? [];
        const parks = rows.slice(index + 1, index + 20).filter(r => r.id - e.id <= SAME_TRANSACTION_IDS && r.kind === 'hold_item' && r.by === 'coordinator'
          && String(detailOf(r.d).reason ?? '').startsWith('landing-repeat-v1:') && entries.some(x => x.id === r.item));
        out.outcome.push({ event: { id: e.id, at: e.at }, snapshot: { batch, batches: [...batches.values()], perItem: true, items: itemsFor(entries.map(x => x.id)), now: e.at, waivers: [...waivers], io: {} },
          move: newRefusal ? { name: 'outcome', refusal: batch.refusal } : { name: 'outcome', culprit: true },
          recorded: { events: parks.map(p => ({ kind: 'hold_item', item: p.item, by: p.by, detail: { reason: decided(detailOf(p.d).reason, p.item) } })) } });
      }
      if (!pendingMerged.length) recordBefore = null;
      return;
    }
    if (e.kind === 'landing_lease') {
      if (e.detail.action === 'request' && e.detail.holder) lease = { holder: { token: e.detail.token, generation: e.detail.generation, branch: 'refs/heads/main', lineage: null, until: FAR } };
      if (e.detail.action === 'release' && lease.holder?.token === e.detail.token) lease = { holder: null };
      return;
    }
    if (e.kind === 'landing_waiver') { if (e.by === 'person') waivers.push(e.detail.waiver); return; }
    if (e.kind === 'main-moved') {
      if (inWindow && recordBefore) checkRecord(e, pendingMerged.filter(m => (recordBefore.batch.items ?? []).some(x => x.id === m.item)), recordBefore);
      else if (inWindow) {
        const batch = [...batches.values()].findLast(b => b.id === e.detail.batch);
        checkRecord(e, [], { batch, items: Object.fromEntries((batch?.items ?? []).map(x => [x.id, { ...(items[x.id] ?? {}) }])) });
      }
      pendingMerged = [];
      recordBefore = null;
      return;
    }
    if (e.kind === 'merged') {
      const before = { ...(items[e.item] ?? { status: 'unknown' }) };
      const finishable = [...batches.values()].findLast(b => ['pushed', 'trunk'].includes(b.state) && (b.items ?? []).some(x => x.id === e.item && x.merge === e.detail.commit));
      if (finishable && !e.detail.forced) {
        if (!pendingMerged.length) recordBefore = { batch: finishable, items: Object.fromEntries((finishable.items ?? []).map(x => [x.id, { ...(items[x.id] ?? {}) }])) };
        pendingMerged.push(e);
      } else if (inWindow) {
        if (e.detail.forced && before.status === 'withdrawn' && statusBeforeWithdraw[e.item] && e.id - statusBeforeWithdraw[e.item].id < SAME_TRANSACTION) before.status = statusBeforeWithdraw[e.item].status;
        checkMerged(e, index, before);
      }
      applyItem(e);
      return;
    }
    applyItem(e);
  });
  return out;
}
