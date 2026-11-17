/** Rebuild every recorded claim and renewal from a board, read-only, as replay records for the claim table [C7,#8241]. */
import { openBoardReadOnly } from '../../../../store/index.js';
import { parseDiagnosis } from '../../../../items/index.js';

/** The board's lease length: every recorded claim's lease ends this long after its write. */
const LEASE_MS = 7_200_000;
const HISTORY = new Set(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'escalate',
  'hold_item', 'unhold_item', 'refreeze', 'reserve', 'reject_returned', 'submit_handoff_returned', 'submit-handoff']);
/** Events after which an item no longer waits on a pulled gate job it was offered. */
const GATE_ENDS = new Set(['claim', 'renew', 'release', 'submit', 'reject', 'reopen', 'withdraw', 'merged', 'submit_handoff_returned']);
const POLICY_FACT = /^policy re-frozen automatically: (\S+) -> (\S+); only (.*) changed$/u;

/** An event's detail as an object; a damaged row reads as empty. */
function detailOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Whether a brief is already in Files, Change and Test form, which the board counts as its own diagnosis when no diagnosis fact exists. */
function briefDiagnosed(brief) {
  try { return Boolean(brief) && Boolean(parseDiagnosis(brief)); } catch { return false; }
}

/** Every item's brief by id; empty on a recorded board whose item table predates the brief column. */
function readBriefs(db) {
  try { return Object.fromEntries(db.prepare('SELECT item_id, item_brief FROM item').all().map(r => [r.item_id, r.item_brief])); } catch { return {}; }
}

/** As the board stores it, without the actor's model, which the event writer stamps on every event and no move decides. */
const stored = ({ model, ...rest }) => JSON.parse(JSON.stringify(rest));

/**
 * Read every claim and renewal recorded since `since`, each rebuilt as a replay record for the claim table.
 * One forward fold over the event log rebuilds each item (status, holder, lease, frozen digest, route, dependencies, holds, gate hand-off)
 * and each seat's live claims; each record's snapshot is the fold just before the claim. Each snapshot copies what the fold later changes. A record's `recorded.events` is what the board
 * wrote in the claim's transaction: the claim or renew, then the policy re-freeze note when one followed.
 * Inputs the board never records are taken from the claim itself and counted in `echoed`: the N it sealed, a gone builder's heartbeat,
 * and a pulled gate job's wait, read from the gate's offer note. Renewals another writer made are listed as unreplayable with why.
 * Why: a table is trusted only once it reproduces what the board really decided, claim by claim.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string, only?: number[], leaseMs?: number }} options - ISO time; claims at or after it are read. `only` keeps the event ids it names.
 * @returns {{ records: object[], unreplayable: { event: number, path: string }[], echoed: Record<string, number> }}
 */
export function readClaimRecords(board, { since, only, leaseMs = LEASE_MS }) {
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    return rebuild(opened ?? board.db, since, only ? new Set(only) : null, leaseMs);
  } finally {
    if (opened) opened.close();
  }
}

/** The fold itself, over an open connection. */
function rebuild(db, since, only, leaseMs) {
  const agents = Object.fromEntries(db.prepare('SELECT agent_id, agent_lane, agent_route FROM agent').all().map(a => [a.agent_id, { lane: a.agent_lane, route: a.agent_route }]));
  const parents = Object.fromEntries(db.prepare('SELECT item_id, item_parent_id FROM item').all().map(r => [r.item_id, r.item_parent_id]));
  const briefs = readBriefs(db);
  const outside = new Set(db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key LIKE 'outside_source:%'").all()
    .filter(r => r.meta_value.includes('pull-request')).map(r => Number(r.meta_key.split(':')[1])));
  const items = new Map();
  const byOwner = new Map();
  const out = { records: [], unreplayable: [], echoed: { seatCap: 0, builderGone: 0, gateOffer: 0 } };

  const setOwner = (it, owner) => {
    if (it.owner) byOwner.get(it.owner)?.delete(it.id);
    it.owner = owner;
    if (owner) (byOwner.get(owner) ?? byOwner.set(owner, new Set()).get(owner)).add(it.id);
  };
  const free = (it) => { it.status = 'open'; setOwner(it, null); it.leaseUntil = null; };
  const handoffLive = (it) => Boolean(it.handoff) && ['queued', 'running'].includes(it.handoff.state) && it.handoff.by === it.owner;
  const awaiting = (it) => it.status === 'claimed' && (it.gateOffered
    || (Boolean(it.handoff) && it.handoff.by === it.owner && it.handoff.digest === it.frozenDigest && ['queued', 'running', 'green'].includes(it.handoff.state)));

  /** Apply one event to the fold. */
  function apply(e) {
    const d = e.detail;
    if (e.kind === 'join' && agents[e.by]) { if (d.route) agents[e.by].route = d.route; if (d.lane) agents[e.by].lane = d.lane; return; }
    if (e.item == null) return;
    if (e.kind === 'add') {
      items.set(e.item, { id: e.item, status: 'open', owner: null, leaseUntil: null, lane: d.lane, route: d.route, after: (d.after ?? []).filter(Number.isInteger),
        parentId: parents[e.item] ?? null, holdReason: null, frozenDigest: null, expectedMinutes: d.expectedBuildMinutes ?? null, builtBy: null, verdict: null,
        merged: false, handoff: null, gateOffered: false, diagnosed: briefDiagnosed(briefs[e.item]), hasFact: false, history: [], claimWaiting: [] });
    }
    const it = items.get(e.item);
    if (!it) return;
    if (HISTORY.has(e.kind)) it.history.push(e);
    if (GATE_ENDS.has(e.kind)) it.gateOffered = false;
    switch (e.kind) {
      case 'claim': case 'renew': it.status = 'claimed'; setOwner(it, e.by); it.leaseUntil = d.leaseUntil; if (d.digest) it.frozenDigest = d.digest; break;
      case 'submit_handoff_returned': if (d.returnedToBoard) break; it.status = 'claimed'; setOwner(it, e.by); if (d.leaseUntil) it.leaseUntil = d.leaseUntil; break;
      case 'release':
        if (!d.review) free(it);
        if (d.idleClaim?.waitingOn?.length) it.claimWaiting = d.idleClaim.waitingOn;
        if (Array.isArray(d.blockedOn) && d.blockedOn.length) { it.after = [...new Set([...it.after, ...d.blockedOn.filter(Number.isInteger)])]; it.claimWaiting = d.blockedOn.filter(Number.isInteger); }
        if (d.reasonCode === 'DIAGNOSIS_WRONG') { it.route = 'mid'; it.hasFact = false; it.diagnosed = briefDiagnosed(briefs[e.item]); }
        break;
      case 'submit': it.status = 'submitted'; it.builtBy = e.by; break;
      case 'accept': it.status = 'verified'; it.verdict = 'ACCEPT'; break;
      case 'reject': free(it); it.verdict = 'REJECT'; break;
      case 'reopen': free(it); break;
      case 'withdraw': free(it); it.status = 'withdrawn'; break;
      case 'merged': free(it); it.status = 'verified'; it.merged = true; break;
      case 'escalate': if (d.to) it.route = d.to; break;
      // A diagnosis fact moves the item to light; a pulled gate's offer note means the item waits on that gate.
      case 'fact':
        if (d.kind === 'diagnosis') { it.route = 'light'; it.hasFact = true; it.diagnosed = true; }
        if (typeof d.text === 'string' && d.text.startsWith(`Gate job gate:${e.item}:`) && it.status === 'claimed') it.gateOffered = true;
        break;
      case 'hold_item': it.holdReason = d.reason ?? 'held'; break;
      case 'unhold_item': it.holdReason = null; break;
      case 'refreeze':
        if (d.after) it.frozenDigest = d.after;
        if (!d.retainedClaim && !d.unchanged) { setOwner(it, null); it.leaseUntil = null; if (it.status === 'claimed') it.status = 'open'; }
        break;
      case 'submit-handoff': it.handoff = { state: d.state, by: e.by === 'coordinator' || e.by === 'board' ? (it.handoff?.by ?? it.owner) : e.by, digest: d.digest ?? it.frozenDigest }; break;
      case 'edit':
        if (typeof d.route === 'string') it.route = d.route;
        // A diagnosis holds only for the criterion, check and brief it was recorded against.
        if ('criterion' in d || 'check' in d || 'brief' in d) it.diagnosed = !it.hasFact && briefDiagnosed(briefs[e.item]);
        if (Array.isArray(d.after)) { it.after = d.after.filter(Number.isInteger); it.claimWaiting = it.claimWaiting.filter(x => d.after.includes(x)); }
        if ('expectedBuildMinutes' in d) it.expectedMinutes = d.expectedBuildMinutes;
        if (d.correctedFrozen) it.frozenDigest = d.correctedFrozen;
        if (d.unfrozen || d.machineVerification) it.frozenDigest = null;
        if (d.expiredHolder) free(it);
        break;
      default:
    }
  }

  const following = db.prepare('SELECT event_id id, event_kind kind, event_by by, item_id item, event_detail d FROM event WHERE event_id>? ORDER BY event_id LIMIT 3');
  /** The policy re-freeze note the board wrote in the claim's own transaction, or null. */
  const policyNote = (e) => following.all(e.id).map(x => ({ ...x, detail: detailOf(x.d) }))
    .find(x => x.kind === 'fact' && x.item === e.item && x.by === e.by && POLICY_FACT.test(x.detail.text ?? '')) ?? null;

  /** The record for one claim or renewal, from the fold as it stands just before it. */
  function record(e) {
    const it = items.get(e.item);
    const d = e.detail;
    const now = new Date(Date.parse(d.leaseUntil) - leaseMs).toISOString();
    const note = e.kind === 'claim' && d.policyRefreshed ? policyNote(e) : null;
    const words = note && POLICY_FACT.exec(note.detail.text);
    const deps = Object.fromEntries([...it.after, ...it.claimWaiting].filter(id => items.has(id)).map(id => {
      const x = items.get(id);
      return [id, { status: x.status, lane: x.lane, merged: x.merged, leaseUntil: x.leaseUntil, gateInFlight: handoffLive(x) }];
    }));
    const actorClaims = [...(byOwner.get(e.by) ?? [])].map(id => items.get(id)).filter(x => x.status === 'claimed')
      .map(x => ({ id: x.id, leaseUntil: x.leaseUntil, parentId: x.parentId, verdict: x.verdict, builtBy: x.builtBy, awaitingGateOrReview: awaiting(x) }));
    if (actorClaims.some(c => items.get(c.id).gateOffered)) out.echoed.gateOffer++;
    const window = it.history.filter(x => ['release', 'reopen'].includes(x.kind) && x.detail.reopenFirstRefusal).at(-1)?.detail.reopenFirstRefusal;
    // Heartbeats are not recorded: a claim the board took inside another builder's open window stands for that builder's gone seat.
    const builderGone = Boolean(window && !window.otherSeatFirst && window.builder !== e.by && now < window.until);
    if (builderGone) out.echoed.builderGone++;
    if (Number.isSafeInteger(d.claimsPerSeat)) out.echoed.seatCap++;
    const snapshot = {
      now, actor: { id: e.by, lane: agents[e.by]?.lane, route: agents[e.by]?.route ?? null, joined: Boolean(agents[e.by]) },
      item: { id: it.id, status: it.status, owner: it.owner, leaseUntil: it.leaseUntil, lane: it.lane, route: it.route, after: [...it.after], parentId: it.parentId,
        holdReason: it.holdReason, frozenDigest: it.frozenDigest, expectedMinutes: it.expectedMinutes, builtBy: it.builtBy, verdict: it.verdict,
        outside: outside.has(it.id) ? 'pull-request' : null, gateInFlight: handoffLive(it), diagnosed: it.diagnosed, returnedRework: false },
      items: deps, claimWaiting: [...it.claimWaiting], laneHold: null, actorClaims, history: [...it.history], usedExitKeys: [],
      io: { checkoutOwner: null, coordinatorPaths: [], provesNothing: null, reworkWindows: null, exitCeiling: null, ledgerWritable: true, sessionCap: null,
        foreignBlocker: null, builderGone, buildBudgetMinutes: d.buildBudgetMinutes ?? 30,
        policyRefresh: d.policyRefreshed ? (words ? { before: words[1], after: words[2], changed: words[3].split(', ') } : { unnamed: true }) : null,
        seatCap: Number.isSafeInteger(d.claimsPerSeat) ? { n: d.claimsPerSeat, how: 'sealed into the claim' } : null,
        // The freeze gets the recorded digest only where the fold says a freeze runs, so a carried digest is really checked.
        freeze: { text: 'frozen', digest: it.frozenDigest === null || d.policyRefreshed || d.adoptedCorrection ? d.digest : 'FREEZE-SHOULD-NOT-RUN' },
        head: d.autoNextSnapshot?.head ?? 'head', autoNextSnapshot: d.autoNextSnapshot ?? null },
      deferred: { barProblem: null, lineCapacity: null, reworkRouting: null, exitContinuation: null,
        submitAdmission: e.kind === 'renew' ? d.submitAdmission ?? null : null, submitOutcome: e.kind === 'renew' ? d.submitOutcome ?? null : null },
    };
    const move = { id: e.item, actor: e.by, leaseMs, itemFolder: d.itemFolder === true, autoNext: Boolean(d.autoNextSnapshot), reviewSkipped: d.reviewSkipped ?? null,
      adoptCorrection: d.adoptedCorrection != null, factId: note?.detail.id };
    const events = [{ kind: e.kind, by: e.by, detail: stored(d) }, ...(note ? [{ kind: 'fact', by: note.by, detail: stored(note.detail) }] : [])];
    return { event: { id: e.id, at: e.at }, snapshot, move, recorded: { events } };
  }

  for (const row of db.prepare('SELECT event_id id, event_at at, event_kind kind, event_by by, item_id item, event_detail d FROM event ORDER BY event_id').iterate()) {
    const e = { id: row.id, at: row.at, kind: row.kind, by: row.by, item: row.item, detail: detailOf(row.d) };
    if ((e.kind === 'claim' || e.kind === 'renew') && e.at >= since && (!only || only.has(e.id)) && items.has(e.item)) {
      if (e.kind === 'renew' && e.detail.queuedRedReturn) out.unreplayable.push({ event: e.id, path: 'renew: written by the gate red return, not the claim command' });
      else out.records.push(record(e));
    }
    apply(e);
  }
  return out;
}
