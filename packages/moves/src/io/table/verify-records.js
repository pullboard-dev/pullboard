/** Rebuild every recorded verdict from a board, read-only, as replay records for the verify table [C7,#8248]. */
import { createHash } from 'node:crypto';
import { openBoardReadOnly } from '../../../../store/index.js';
import { frozenBar } from '../../../../verify/browser.js';

const HISTORY = new Set(['add', 'edit', 'claim', 'renew', 'release', 'submit', 'accept', 'reject', 'reopen', 'withdraw', 'merged', 'escalate',
  'hold_item', 'unhold_item', 'refreeze', 'reserve', 'bar-sharpen', 'strong-rejection-notice', 'fact']);
const FOLLOW = new Set(['hold_item', 'bar-sharpen', 'escalate', 'strong-rejection-notice']);
const RELAXED = /\nreview family relaxed at reservation: [^\n]*$/u;
/** The frozen verify policy a verdict ran under, when the board no longer holds the one frozen at claim: any seat, no family rule. */
const STAND_IN_POLICY = Object.freeze({ version: 1, commit: '0'.repeat(40), verify: { policy: 'any', family: 'off' } });
const FLAKE_OBSERVATION_STAMP = 61;

/** As the board stores it, without the actor's model, which the event writer stamps on every event and no move decides. */
const stored = ({ model, ...rest }) => JSON.parse(JSON.stringify(rest));
const detailOf = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const barHash = (frozenText) => createHash('sha256').update(JSON.stringify(frozenBar({ item_frozen: frozenText }))).digest('hex');

/**
 * Read every verdict recorded since `since`, each rebuilt as a replay record: the item as it stood just before the verdict, the move the command made,
 * and `recorded.events`, what the board wrote in the verdict's own transaction (the accept or reject, then its automatic hold, sharpen, escalation or notice, then any implied facts).
 * A verdict the table cannot decide from history alone is listed with why. The board keeps only an item's current frozen bar, so a policy it no longer holds
 * is stood in for with the plain one, and `notes` counts how often.
 * Why: a table is trusted only once it reproduces what the board really decided, verdict by verdict.
 *
 * @param {string | { db: object }} board - A board file path, or an open board (only SELECTed).
 * @param {{ since: string, only?: number[] }} options - ISO time; verdicts at or after it are read. `only` keeps just the verdict event ids it names.
 * @returns {{ verify: object[], unreplayable: { event: number, path: string }[], notes: Record<string, number> }}
 */
export function readVerifyRecords(board, { since, only }) {
  const opened = typeof board === 'string' ? openBoardReadOnly(board) : null;
  try {
    return rebuild(opened ?? board.db, since, only ? new Set(only) : null);
  } finally {
    if (opened) opened.close();
  }
}

/** The forward fold over the event log, snapshotting just before each verdict in the window. */
function rebuild(db, since, only) {
  const agents = Object.fromEntries(db.prepare('SELECT agent_id, agent_route FROM agent').all().map(a => [a.agent_id, { route: a.agent_route }]));
  const current = Object.fromEntries(db.prepare('SELECT item_id, item_frozen, item_frozen_digest, item_lane FROM item').all().map(r => [r.item_id, r]));
  const outside = new Set(db.prepare("SELECT meta_key FROM board_meta WHERE meta_key LIKE 'outside_source:%'").all().map(r => Number(r.meta_key.split(':')[1])));
  const sharpenSetting = db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='line_setting:bar.sharpenToPerson'").get()?.meta_value;
  const verdictsOf = new Map();
  for (const v of db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all()) (verdictsOf.get(v.item_id) ?? verdictsOf.set(v.item_id, []).get(v.item_id)).push(v);
  const rowOf = (v) => ({ id: v.verdict_id, item: v.item_id, by: v.verdict_by, decision: v.verdict_decision, reason: v.verdict_reason, note: v.verdict_note,
    commit: v.verdict_commit, digest: v.verdict_digest, head: v.verdict_head, family: v.verdict_verifier_family ?? null, at: v.verdict_at });
  const items = new Map();
  const flakes = new Map();
  const follow = db.prepare('SELECT event_id id, event_kind kind, event_by by, item_id item, event_detail d FROM event WHERE event_id>? ORDER BY event_id LIMIT 8');
  const shoutRow = db.prepare('SELECT shout_to, shout_text, shout_decision FROM shout WHERE shout_id=?');
  const out = { verify: [], unreplayable: [], notes: { policyStoodIn: 0, barStoodIn: 0, relaxed: 0, causeGiven: 0, causeDerived: 0 } };

  for (const row of db.prepare('SELECT event_id id, event_at at, event_kind kind, event_by by, item_id item, event_detail d FROM event ORDER BY event_id').iterate()) {
    const e = { id: row.id, at: row.at, kind: row.kind, by: row.by, item: row.item, detail: detailOf(row.d) };
    if ((e.kind === 'accept' || e.kind === 'reject') && e.at >= since && (!only || only.has(e.id))) record(e);
    apply(e);
  }
  return out;

  /** Apply one event to the fold. */
  function apply(e) {
    if (e.kind === 'join' && agents[e.by] && e.detail.route) { agents[e.by].route = e.detail.route; return; }
    if (e.kind === 'flake-observation') (flakes.get(e.by) ?? flakes.set(e.by, []).get(e.by)).push({ id: e.id, detail: e.detail });
    if (e.item == null) return;
    let it = items.get(e.item);
    if (e.kind === 'add') {
      it = { id: e.item, status: 'open', owner: null, route: e.detail.route, lane: e.detail.lane, frozenDigest: null, commit: null, builtBy: null, merged: false,
        reviewBy: null, reviewUntil: null, history: [], verdicts: 0 };
      items.set(e.item, it);
    }
    if (!it) return;
    if (HISTORY.has(e.kind)) it.history.push({ id: e.id, kind: e.kind, by: e.by, detail: e.detail });
    const d = e.detail;
    switch (e.kind) {
      case 'claim': case 'renew': it.status = 'claimed'; it.owner = e.by; if (d.digest) it.frozenDigest = d.digest; break;
      case 'submit_handoff_returned': it.status = 'claimed'; it.owner = e.by; break;
      case 'release': if (d.review) { it.reviewBy = null; it.reviewUntil = null; } else { it.status = 'open'; it.owner = null; } if (d.reasonCode === 'DIAGNOSIS_WRONG') it.route = 'mid'; break;
      case 'submit': if (d.commit) { it.status = 'submitted'; it.builtBy = e.by; it.commit = d.commit; it.reviewBy = null; it.reviewUntil = null; } break;
      case 'reserve': it.reviewBy = e.by; it.reviewUntil = d.until ?? null; break;
      case 'accept': it.status = 'verified'; it.reviewBy = null; it.reviewUntil = null; it.verdicts++; break;
      case 'reject': it.status = 'open'; it.owner = null; it.reviewBy = null; it.reviewUntil = null; it.verdicts++; break;
      case 'reopen': it.status = 'open'; it.owner = null; break;
      case 'withdraw': it.status = 'withdrawn'; it.owner = null; break;
      case 'merged': it.status = 'verified'; it.merged = true; it.owner = null; break;
      case 'escalate': if (d.to) it.route = d.to; it.owner = null; break;
      case 'fact': if (d.kind === 'diagnosis') it.route = 'light'; break;
      case 'refreeze': if (d.after) it.frozenDigest = d.after; if (!d.retainedClaim && !d.unchanged) { it.owner = null; if (it.status === 'claimed') it.status = 'open'; } break;
      case 'edit':
        if (typeof d.route === 'string') it.route = d.route;
        if (d.correctedFrozen) it.frozenDigest = d.correctedFrozen;
        if (d.unfrozen || d.machineVerification) it.frozenDigest = null;
        if (d.expiredHolder) { it.status = 'open'; it.owner = null; }
        break;
      default:
    }
  }

  /** What the board wrote right after the verdict on this item: its automatic follow-ups, their shouts, and the facts an --implies wrote. */
  function followWrites(e) {
    const written = [];
    for (const x of follow.all(e.id).map(row => ({ ...row, detail: detailOf(row.d) }))) {
      if (x.kind === 'shout' && x.item === null && ['sentinel', 'coordinator'].includes(x.by)) {
        // The event holds only the shout's id; its words and addressee are in the shout row. The lane list is not kept, and is always the coordinator's.
        const shout = shoutRow.get(x.detail.shout);
        if (!String(shout?.shout_text ?? '').startsWith(`#${e.item} `)) continue;
        written.push({ kind: x.kind, item: null, by: x.by, detail: { to: shout.shout_to, lanes: ['coordinator'], ...(written.some(w => w.kind === 'bar-sharpen') ? { decision: shout.shout_decision === 1 } : {}), text: shout.shout_text } });
      } else if (x.kind === 'fact' && e.detail.implies?.includes(x.item)) written.push({ kind: x.kind, item: x.item, by: x.by, detail: stored(x.detail) });
      else if (e.kind === 'reject' && x.item === e.item && ['coordinator', 'sentinel', 'board'].includes(x.by) && FOLLOW.has(x.kind)) written.push({ kind: x.kind, by: x.by, detail: stored(x.detail) });
      else if (x.item === e.item && !['coordinator', 'sentinel', 'board'].includes(x.by)) break;
    }
    return written;
  }

  /** Snapshot the item before the verdict, rebuild the move, and push the record. */
  function record(e) {
    const it = items.get(e.item), d = e.detail;
    const v = verdictsOf.get(e.item)?.[it?.verdicts ?? -1];
    const skip = (path) => out.unreplayable.push({ event: e.id, path });
    if (!it || !v || v.verdict_decision !== e.kind.toUpperCase()) return skip(`${e.kind}: no verdict row or item fold for this event`);
    if (outside.has(e.item)) return skip(`${e.kind}: an outside PR verdict, which has its own sandbox path`);
    const cur = current[e.item];
    const relaxed = RELAXED.exec(v.verdict_note);
    if (relaxed) out.notes.relaxed++;
    const reject = e.kind === 'reject';
    // A reject's barKey hashes the bar it judged: when the bar now holds the same hash it is the bar the reviewer saw, even if the digest moved.
    const barSame = reject ? d.barKey === barHash(cur.item_frozen) : cur.item_frozen_digest === v.verdict_digest;
    let frozen = cur.item_frozen;
    const parsed = detailOf(frozen);
    if (!(parsed.policy?.version === 1 && /^[0-9a-f]{40,64}$/.test(parsed.policy.commit ?? ''))) {
      out.notes.policyStoodIn++;
      frozen = JSON.stringify({ ...parsed, policy: STAND_IN_POLICY });
    }
    let barAdjusted = false;
    if (reject && !barSame && typeof d.clauseText === 'string') {
      // The bar text is gone; stand in a bar whose only clause is the one recorded, so every other rule and effect is still checked.
      barAdjusted = true;
      out.notes.barStoodIn++;
      frozen = JSON.stringify({ criterion: d.clauseText, policy: detailOf(frozen).policy });
    }
    const impliedFacts = d.implies?.length ? followWrites(e).filter(x => x.kind === 'fact') : null;
    if (reject) out.notes[d.causeDerivation ? 'causeDerived' : 'causeGiven']++;
    const snapshot = {
      now: v.verdict_at,
      actor: { id: e.by, joined: Boolean(agents[e.by]) || e.by === 'coordinator', route: agents[e.by]?.route ?? 'strong', family: v.verdict_verifier_family ?? null },
      item: { id: it.id, status: it.status, merged: it.merged, commit: it.commit, frozenDigest: it.frozenDigest, frozen, route: it.route, lane: it.lane ?? cur.item_lane,
        builtBy: it.builtBy, owner: it.owner, reviewBy: it.reviewBy, reviewUntil: it.reviewUntil, effectiveHead: null, outside: null },
      history: [...it.history], verdicts: (verdictsOf.get(e.item) ?? []).slice(0, it.verdicts).map(rowOf),
      knownItems: d.implies ?? [], actorFlakeObservations: flakes.get(e.by) ?? [], nativeFlakeEngine: FLAKE_OBSERVATION_STAMP,
      lineSettings: { sharpenToPerson: sharpenSetting ? detailOf(sharpenSetting) : false },
      nextEventId: e.id, nextVerdictId: v.verdict_id,
      // This verdict was recorded, so every command check it ran passed; the review holder's heartbeat is local presence the board never kept.
      io: { isMain: e.by === 'coordinator', mainRefusal: null, selfSession: false, staleAcceptance: it.status === 'verified', policyRefused: null, commitInHead: true, root: '/repo',
        missingCompanions: null, checkRefused: null, selectorGap: false, reviewHolderFresh: false },
      deferred: { environmentProblem: null, knownMainProblem: null, quarantineProblem: null, gateReceipt: null, companionWindow: null, authorProblem: null, requiredFamily: null,
        familyProblem: null, patchProblem: null, sandboxProblem: null, relaxation: relaxed ? relaxed[0].slice(1) : null, assurance: null, impliedFacts },
    };
    const move = { id: e.item, actor: e.by, decision: e.kind.toUpperCase(), ...(e.by === 'coordinator' ? { as: 'coordinator' } : {}),
      reason: reject ? v.verdict_reason : undefined, note: relaxed ? v.verdict_note.slice(0, relaxed.index) : v.verdict_note,
      ...(reject && !d.causeDerivation && d.cause !== undefined ? { cause: d.cause } : {}), ...(reject ? { clause: d.clause } : {}),
      head: v.verdict_head, digest: v.verdict_digest, review: d.review, sourceAdvanceHead: null,
      ...(d.companionDigest ? { companionDigest: d.companionDigest } : {}), ...(d.policy ? { itemReviewPolicy: d.policy } : {}), ...(Object.hasOwn(d, 'environment') ? { environment: d.environment } : {}),
      ...(d.check !== undefined ? { check: d.check } : {}), ...(d.knownMainFailures !== undefined ? { knownMainFailures: d.knownMainFailures } : {}),
      ...(d.quarantineProofId !== undefined ? { quarantineProofId: d.quarantineProofId } : {}), ...(d.sandbox !== undefined ? { sandbox: d.sandbox } : {}), ...(d.implies ? { implies: d.implies } : {}) };
    const written = [{ kind: e.kind, by: e.by, detail: stored(d) }, ...followWrites(e).filter(x => x.kind !== 'fact' || !impliedFacts)];
    // With the bar stood in, its hash is the stand-in's, and a sharpen the board counted on the lost bar cannot be reproduced.
    if (barAdjusted) {
      if (written.some(x => x.kind === 'bar-sharpen')) return skip('reject: sharpen counts clauses of a bar refrozen since');
      written[0].detail.barKey = barHash(frozen);
    }
    out.verify.push({ event: { id: e.id, at: e.at }, snapshot, move, recorded: { events: written, verdictRow: rowOf(v) }, ...(barAdjusted ? { barAdjusted: true } : {}) });
  }
}
