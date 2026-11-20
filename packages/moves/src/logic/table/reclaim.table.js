/** Maintenance releases as one pure table: the board taking work back from a seat that went quiet, stranded dependencies included, ported from the pure-core pilot [C7,#8240]. */
import { defineRules } from './rules.js';

/**
 * The limits maintenance applies, as the board applies them today; replay over recorded history checks they still agree.
 * Why: the live constants sit inside the store and health cells with no front-door export; recorded history is what proves these match.
 */
export const RECLAIM_LIMITS = Object.freeze({ seatQuietMs: 120_000, stallMs: 20 * 60_000, idleReleaseMs: 30 * 60_000, pinnedReleaseMs: 30 * 60_000, recentCommitMs: 30 * 60_000 });
const IDLE_KINDS = Object.freeze(['stall', 'release', 'waiting', 'progress', 'seat-gone', 'dependency']);
const BAD = 'stale-state maintenance needs complete captured native observations';
const CHANGED = 'the board changed after the stale-state observation';
const NEXT = 'run the command again; maintenance captures a fresh observation';

/** A canonical ISO instant at or before `now`, as a number; anything else proves nothing. */
function instant(value, now) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && new Date(at).toISOString() === value ? at : null;
}

/** One line naming the kept work: the pinned ref and changed files, or why nothing was pinned. */
export function handoffText(handoff) {
  if (!handoff.pin) return `no work could be pinned: ${handoff.unpinned}`;
  const shown = handoff.changedFiles.slice(0, 8);
  const more = handoff.changedCount - shown.length;
  return `work kept at ${handoff.pin} (${handoff.changedCount} file(s): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
}

/** A hand-off record is complete: a pinned ref with its head, or a stated reason nothing was pinned. */
const handoffValid = (h, id) => Boolean(h) && Array.isArray(h.changedFiles) && h.changedFiles.length <= 200
  && Number.isSafeInteger(h.changedCount) && h.changedCount >= h.changedFiles.length
  && (h.pin === null ? typeof h.unpinned === 'string' && h.unpinned.length > 0
    : /^[0-9a-f]{40,64}$/u.test(h.head ?? '') && typeof h.pin === 'string' && h.pin.startsWith(`refs/pullboard/handoffs/${id}/`));

/** The idle-claim checks that make a captured row stale or malformed; the code says which, or null. */
function idleProblem(s, m) {
  const r = m.row, observed = Date.parse(m.observedAt);
  if (s.item.status !== 'claimed' || s.item.owner !== r.actor || s.item.owner === m.maintainer || s.ownerLastClaimId !== r.claimEventId) return 'STALE_STATE_CHANGED';
  // An unsettled gate is the board's work: no idle rule, seat-gone included, takes its claim, as the store's re-check says [C7,#10931,#10934].
  if (s.gateInFlight === true) return 'STALE_STATE_CHANGED';
  if (!IDLE_KINDS.includes(r.idle)) return 'BAD_STALE_STATE';
  if (r.idle === 'seat-gone') {
    const last = Date.parse(r.deadSeat?.heartbeatAt ?? r.claimAt ?? '');
    return r.deadSeat?.observedAt !== m.observedAt || r.deadSeat?.quietMs !== RECLAIM_LIMITS.seatQuietMs
      || (r.deadSeat?.worktreeMissing !== true && (!Number.isFinite(last) || observed - last < RECLAIM_LIMITS.seatQuietMs)) ? 'BAD_STALE_STATE' : null;
  }
  if (r.idle === 'waiting') {
    if (!Array.isArray(r.waitingOn) || !r.waitingOn.length) return 'BAD_STALE_STATE';
    const open = r.waitingOn.filter(id => s.item.after.includes(id) && s.deps[id] && s.deps[id].status !== 'withdrawn' && !s.deps[id].merged);
    return open.length !== r.waitingOn.length ? 'STALE_STATE_CHANGED' : null;
  }
  if (s.redReturnLease) return 'STALE_STATE_CHANGED';
  if (r.idle === 'progress') {
    if (r.commitAt != null && observed - Date.parse(r.commitAt) < RECLAIM_LIMITS.recentCommitMs) return 'BAD_STALE_STATE';
    if (!s.progressNow?.trigger || JSON.stringify(s.progressNow) !== JSON.stringify(r.progress)) return 'BAD_STALE_STATE';
  } else {
    if (r.idle === 'dependency') {
      if (!s.waiters?.length || JSON.stringify(s.waiters) !== JSON.stringify(r.dependents)) return 'STALE_STATE_CHANGED';
      if (r.resourceQuiet !== true || !s.lastWork || s.lastWork !== r.workActivity || r.idleMs !== observed - Date.parse(s.lastWork) || r.idleMs < m.limits?.dependency) return 'BAD_STALE_STATE';
    }
    const last = instant(r.workActivity, observed);
    const limit = r.idle === 'dependency' ? m.limits.dependency : r.idle === 'release' ? (s.pinned ? RECLAIM_LIMITS.pinnedReleaseMs : RECLAIM_LIMITS.idleReleaseMs) : RECLAIM_LIMITS.stallMs;
    if (last === null || r.idleMs !== observed - last || r.idleMs < limit) return 'BAD_STALE_STATE';
  }
  if (['release', 'progress', 'dependency'].includes(r.idle) && !handoffValid(r.handoff, r.id)) return 'BAD_STALE_STATE';
  return null;
}

/** The lapsed-claim checks: the lease is exactly the captured one and has been past its interval since; the code, or null. */
function lapseProblem(s, m) {
  const r = m.row, lease = s.ownerLastLease, observed = Date.parse(m.observedAt);
  const leaseMs = Date.parse(s.item.leaseUntil) - Date.parse(lease?.at);
  if (!lease || s.item.status !== 'claimed' || s.item.owner !== r.actor || s.item.owner === m.maintainer || s.item.leaseUntil !== r.leaseUntil
    || lease.id !== r.leaseEventId || lease.at !== r.leaseStartedAt || lease.leaseUntil !== r.leaseUntil
    || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || r.leaseMs !== leaseMs) return 'STALE_STATE_CHANGED';
  const at = instant(r.lastActivity, observed), leaseAt = instant(r.leaseUntil, observed);
  if (r.evidence?.complete !== true || at === null || r.limitMs !== m.limits.claim || observed - at < m.limits.claim
    || leaseAt === null || observed - leaseAt < m.limits.claim) return 'BAD_STALE_STATE';
  // A lapsed lease waits for the item's unsettled gate too, checked last as the store checks it [C7,#10931,#10934].
  if (s.gateInFlight === true) return 'STALE_STATE_CHANGED';
  return null;
}

/** The idle-review checks: the same reservation of the same submission, idle past the review limit; the code, or null. */
function reviewProblem(s, m) {
  const r = m.row, observed = Date.parse(m.observedAt);
  if (s.item.status !== 'submitted' || s.item.reviewer !== r.reviewer || s.item.commit !== r.commit || s.item.reviewUntil !== r.reviewUntil
    || s.reserve?.id !== r.reserveEventId || s.reserve?.at !== r.reservedAt || s.lastSubmitId !== r.sourceSubmitEventId) return 'STALE_STATE_CHANGED';
  const at = instant(r.lastActivity, observed);
  if (r.evidence?.complete !== true || at === null || r.limitMs !== m.limits.review || observed - at < m.limits.review) return 'BAD_STALE_STATE';
  return null;
}

/** The release reason for each idle kind, exactly as the board words it. */
function idleReason(r) {
  if (r.idle === 'dependency') return `Stale dependency: no commit, test run or fact since ${r.workActivity}, past health.dependencyIdle; ${handoffText(r.handoff)}.`;
  if (r.idle === 'seat-gone') return `Seat ${r.actor} has no heartbeat for two minutes or its worktree is gone; claim returned to the queue.`;
  if (r.idle === 'progress') return `Returned after ${r.progress.trigger}; holder ${r.actor}'s notes: ${r.progress.notes.join(', ') || 'none recorded'} (pullboard show ${r.id} --detail); ${handoffText(r.handoff)}.`;
  if (r.idle === 'waiting') return `Waiting on ${r.waitingOn.map(id => `#${id}`).join(', ')}, which has not landed; the item returns to the queue when it lands.`;
  return `Idle ${Math.floor(r.idleMs / 60_000)} minutes: no commit, file change, running check or item move since ${r.workActivity}; ${handoffText(r.handoff)}.`;
}

/** The closed release code of each idle kind when the move carries boardCodes: a waiting claim stays BLOCKED. */
function idleCode(kind) {
  return kind === 'seat-gone' ? 'SEAT_GONE' : kind === 'waiting' ? 'BLOCKED' : kind === 'progress' ? 'NO_PROGRESS' : 'BUILDER_SILENT';
}

/** The fact that a check of this move kind does not find the given problem code. */
const passes = (kind, problem, code) => (s, m) => m.kind !== kind || problem(s, m) !== code;
const free = () => ({ status: 'open', owner: null, leaseUntil: null });

/**
 * The reclaim rules. Snapshot: the item, its owner's last claim and lease, waited-on deps, reservation and progress as captured;
 * move: `{ kind: 'idle'|'lapsed-claim'|'review-idle'|'review-lapse', maintainer, observedAt, row, limits, lapse, now, seenAt }`.
 */
export const RECLAIM_RULES = defineRules({
  idleCurrent: { says: 'an idle claim is still held as observed', holds: passes('idle', idleProblem, 'STALE_STATE_CHANGED') },
  idleProven: { says: 'an idle claim is quiet past its rule, with complete observations', holds: passes('idle', idleProblem, 'BAD_STALE_STATE') },
  lapseCurrent: { says: 'a lapsed claim keeps its captured lease', holds: passes('lapsed-claim', lapseProblem, 'STALE_STATE_CHANGED') },
  lapseProven: { says: 'a lapsed claim is past its stale interval, with complete observations', holds: passes('lapsed-claim', lapseProblem, 'BAD_STALE_STATE') },
  reviewCurrent: { says: 'an idle review is the same reservation of the same submission', holds: passes('review-idle', reviewProblem, 'STALE_STATE_CHANGED') },
  reviewProven: { says: 'an idle review is idle past the review limit, with complete observations', holds: passes('review-idle', reviewProblem, 'BAD_STALE_STATE') },
  reviewLapseLive: { says: 'a lapsed review lease frees only a review its reviewer still holds',
    holds: (s, m) => m.kind !== 'review-lapse' || (s.item?.status === 'submitted' && s.item.reviewer === m.lapse.reviewer && Date.parse(s.item.reviewUntil ?? '') > Date.parse(m.now)) },
  stallNotice: { says: 'an idle claim past the stall limit only earns a notice', holds: (s, m) => m.kind === 'idle' && m.row.idle === 'stall' },
  idleClaim: { says: 'the move reclaims an idle claim', holds: (s, m) => m.kind === 'idle' },
  lapsedClaim: { says: 'the move expires a lapsed claim', holds: (s, m) => m.kind === 'lapsed-claim' },
  idleReview: { says: 'the move frees an idle review', holds: (s, m) => m.kind === 'review-idle' },
  lapsedReview: { says: 'the move frees a review whose lease lapsed', holds: (s, m) => m.kind === 'review-lapse' },
});

/** The table and its rules, as the engine the board root hands the store's maintenance shadow compare [C7,#9367]. */
export function reclaimEngine() {
  return { table: RECLAIM_TABLE, rules: RECLAIM_RULES };
}

/** The reclaim table: one guard per refusal code of each captured observation, then one outcome per maintenance kind. */
export const RECLAIM_TABLE = Object.freeze({
  name: 'reclaim',
  guards: Object.freeze([
    { id: 'idle-current', requires: 'idleCurrent', code: 'STALE_STATE_CHANGED', message: CHANGED, next: NEXT },
    { id: 'idle-proven', requires: 'idleProven', code: 'BAD_STALE_STATE', message: BAD, next: NEXT },
    { id: 'lapse-current', requires: 'lapseCurrent', code: 'STALE_STATE_CHANGED', message: CHANGED, next: NEXT },
    { id: 'lapse-proven', requires: 'lapseProven', code: 'BAD_STALE_STATE', message: BAD, next: NEXT },
    { id: 'review-current', requires: 'reviewCurrent', code: 'STALE_STATE_CHANGED', message: CHANGED, next: NEXT },
    { id: 'review-proven', requires: 'reviewProven', code: 'BAD_STALE_STATE', message: BAD, next: NEXT },
    { id: 'review-lapse-live', requires: 'reviewLapseLive', code: 'SKIP', message: 'the reservation already moved; nothing to free', next: 'nothing to do' },
  ]),
  outcomes: Object.freeze([
    { id: 'stall-notice', when: 'stallNotice', patch: () => ({}),
      events: (s, m) => [{ kind: 'claim_stalled', by: m.maintainer, detail: { holder: m.row.actor, lastActivity: m.row.workActivity, idleMinutes: Math.floor(m.row.idleMs / 60_000), observedAt: m.observedAt } }] },
    { id: 'reclaim-idle', when: 'idleClaim', patch: free,
      events: (s, m) => {
        const r = m.row, reason = idleReason(r);
        return [
          ...(r.idle === 'progress' ? [{ kind: 'fact', by: 'board', detail: { id: `progress-return-${r.id}-${r.claimEventId}`, kind: 'note', text: reason, ref: null, supersedes: null } }] : []),
          { kind: 'release', by: m.maintainer, detail: { reason,
            ...(r.idle === 'seat-gone' ? { reclaim: { seat: r.actor, heartbeatAt: r.deadSeat.heartbeatAt, worktreeMissing: r.deadSeat.worktreeMissing, observedAt: m.observedAt } } : {}),
            ...(r.idle === 'progress' ? { reopenFirstRefusal: { builder: r.actor, otherSeatFirst: true, until: new Date(Date.parse(m.observedAt) + 7_200_000).toISOString() } } : {}),
            reasonCode: m.boardCodes ? idleCode(r.idle) : r.idle === 'waiting' ? 'BLOCKED' : 'OTHER',
            idleClaim: { holder: r.actor, kind: r.idle, lastActivity: r.workActivity ?? null, observedAt: m.observedAt, claimEventId: r.claimEventId,
              ...(r.idle === 'waiting' ? { waitingOn: r.waitingOn } : { handoff: r.handoff }) } } },
        ];
      } },
    { id: 'expire-lapsed-claim', when: 'lapsedClaim', patch: free,
      events: (s, m) => [{ kind: 'release', by: m.maintainer, detail: { reason: 'Lapsed claim idle past its stale interval.', reasonCode: m.boardCodes ? 'LEASE_LAPSED' : 'OTHER',
        expiredClaim: { holder: m.row.actor, leaseUntil: m.row.leaseUntil, lastActivity: m.row.lastActivity, observedAt: m.observedAt, leaseEventId: m.row.leaseEventId },
        reopenFirstRefusal: { builder: s.item.owner, until: new Date(Date.parse(m.now) + m.row.leaseMs).toISOString() } } }] },
    { id: 'free-idle-review', when: 'idleReview', patch: () => ({ reviewer: null, reviewUntil: null }),
      events: (s, m) => [{ kind: 'release', by: m.maintainer, detail: { review: true, reason: `Review idle for 30 minutes; last observed activity ${m.row.lastActivity}.`, reasonCode: m.boardCodes ? 'REVIEW_IDLE' : 'OTHER',
        stale: { reviewer: m.row.reviewer, reservedAt: m.row.reservedAt, lastActivity: m.row.lastActivity } } }] },
    { id: 'free-lapsed-review', when: 'lapsedReview', patch: () => ({ reviewer: null, reviewUntil: null }),
      events: (s, m) => {
        const now = Date.parse(m.now), seen = m.seenAt ? Date.parse(m.seenAt) : null;
        const minutes = Math.round((now - (seen ?? now - m.lapse.lapsedMs)) / 60_000);
        return [{ kind: 'release', by: 'coordinator', detail: { review: true, reason: `Review silent for ${minutes} minutes; its reservation lease lapsed.`, reasonCode: m.boardCodes ? 'REVIEW_LEASE_LAPSED' : 'OTHER',
          lapsed: { reviewer: m.lapse.reviewer, lapsedMs: m.lapse.lapsedMs } } }];
      } },
  ]),
});
