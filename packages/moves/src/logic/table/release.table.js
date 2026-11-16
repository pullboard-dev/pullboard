/** The release move as one pure table: every rule the board enforces when a seat hands back a claim or a review, ported from the pure-core pilot [C7,#8240]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';
import { RELEASE_NEXT } from './next.js';
export { RELEASE_NEXT } from './next.js';

/** Reasons a holder's release counts toward the release-twice rule. */
const QUALITY = Object.freeze(['BLOCKED', 'BUDGET', 'INELIGIBLE']);
const ROUTES = Object.freeze(['light', 'mid', 'strong']);

const SHOUT = RELEASE_NEXT.NOT_YOURS;
const REASON_NEXT = RELEASE_NEXT.RELEASE_REASON;
const DIAGNOSIS_NEXT = 'claim the diagnosed item, then release it with --reason DIAGNOSIS_WRONG --note "<what was wrong>"';
const STALE_CHANGED = 'the claim changed after the stale observation; capture it again before releasing';
const LIFECYCLE = Object.freeze(['claim', 'release', 'submit', 'withdraw', 'merged', 'reopen']);

/** Any line break, including the Unicode line and paragraph separators; built without escapes so no edit tool can mangle it. */
const LINE_BREAK = new RegExp(`[\r\n${String.fromCharCode(0x2028, 0x2029)}]`, 'u');
const blank = (note) => !(typeof note === 'string' && note.trim());
const trimmed = (note) => (typeof note === 'string' ? note.trim() : '');
const claimedByMe = (s, m) => s.item?.status === 'claimed' && s.item.owner === m.actor;

/** The seats module's unjoined refusal: it names this session's seats in other checkouts, with an always-quoted cd. */
function unjoined(s) {
  const join = 'pullboard join <lane> --model "<model name>"';
  const seats = s.io?.sessionSeats ?? [];
  if (!seats.length) return { message: `this worktree has not joined a lane; run ${join}`, next: RELEASE_NEXT.NOT_JOINED };
  return { message: `this checkout has no seat, and your session's seats work in their own checkouts: ${seats.map(x => `${x.id} (${x.lane} lane) in ${x.path}`).join('; ')}`,
    next: `continue in that seat: cd '${seats[0].path.replaceAll("'", `'\\''`)}' && pullboard next; or give this checkout its own seat: ${join}` };
}

/** A canonical ISO instant at or before `now`, as a number; anything else proves nothing. */
function instant(value, now) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && new Date(at).toISOString() === value ? at : null;
}

/** History with an id on every entry: events a follow-up sees from earlier in the same move get the next ids, as the board would write them. */
function numbered(history) {
  let last = Math.max(0, ...history.map(entry => entry.id ?? 0));
  return history.map(entry => (entry.id === undefined ? { ...entry, id: ++last } : entry));
}

/** A claim the holder got from `next` and handed back with the worktree exactly as `next` left it. */
const untouched = (s, m) => !m.stale && s.lastClaim?.by === m.actor && typeof m.worktreeSnapshot?.digest === 'string'
  && m.worktreeSnapshot.head === s.lastClaim.detail?.autoNextSnapshot?.head && m.worktreeSnapshot.digest === s.lastClaim.detail?.autoNextSnapshot?.digest;

/** Releases the holder chose for themselves, which the route and release-twice rules count. */
const chosenByHolder = (before, m) => !m.stale && !untouched(before, m) && claimedByMe(before, m);

const combinedAfter = (s, m) => [...new Set([...s.item.after.map(String), ...m.on.map(String)])].map(Number);

/** Walk --on through the board's dependency graph; the first refusal a real write would hit, or null. */
function dependencyProblem(s, m) {
  const after = combinedAfter(s, m);
  for (const id of after) if (!s.items[id]) return { code: 'NO_ITEM', message: `no item #${id}; see: pullboard list` };
  const withdrawn = after.find(id => s.items[id].status === 'withdrawn');
  if (withdrawn !== undefined) return { code: 'WITHDRAWN', message: `item #${withdrawn} is withdrawn; nothing can wait on it` };
  const seen = new Set();
  const pending = [...after];
  while (pending.length) {
    const id = pending.pop();
    if (id === m.id) return { code: 'DEPENDENCY_CYCLE', message: `item #${m.id} cannot wait on itself through its dependencies; change --after to remove the cycle` };
    if (seen.has(id)) continue;
    if (!s.items[id]) return { code: 'NO_ITEM', message: `no item #${id}; see: pullboard list` };
    seen.add(id);
    pending.push(...s.items[id].after);
  }
  return null;
}

/** Infrastructure caused a release when it names INFRA, or its holder's last hand-off since their claim ended in infrastructure. */
function infraCaused(history, release) {
  if (release.detail?.reasonCode === 'INFRA') return true;
  const claim = history.filter(e => e.kind === 'claim' && e.id < release.id).at(-1);
  const handoff = history.filter(e => e.kind === 'submit-handoff' && e.by === release.by && e.id > (claim?.id ?? 0) && e.id < release.id).at(-1);
  return handoff?.detail?.state === 'infrastructure';
}

/** A release the holder chose for a quality reason, counted toward the release-twice rule. */
function chosenQuality(history, release) {
  const d = release.detail ?? {};
  if (!QUALITY.includes(d.reasonCode) || d.review || d.staleClaim || d.goneSeat || d.idleClaim || d.expiredClaim
    || d.untouchedAutoClaim || d.exitHandoff || infraCaused(history, release)) return false;
  const before = history.filter(e => e.id < release.id && LIFECYCLE.includes(e.kind)).at(-1);
  return before?.kind === 'claim' && before.by === release.by;
}

/** The two newest chosen quality releases since the last unhold and the last route change, newest first. */
function lastTwoChosen(s) {
  const history = numbered(s.history ?? []);
  const unhold = Math.max(0, ...history.filter(e => e.kind === 'unhold_item').map(e => e.id));
  const routeChange = Math.max(0, ...history.filter(e => e.kind === 'escalate' && e.detail?.from !== e.detail?.to).map(e => e.id));
  return history.filter(e => e.kind === 'release' && e.id > unhold && e.id > routeChange && chosenQuality(history, e)).reverse().slice(0, 2);
}

const listReasons = (releases) => [...releases].reverse().map(e => `${e.by}: ${e.detail.reasonCode}${e.detail.reason ? ` (${e.detail.reason})` : ''}`).join('; ');
const nextRoute = (route) => ROUTES[Math.min(ROUTES.indexOf(route) + 1, ROUTES.length - 1)];
const escalation = (s, note) => ({ patch: { route: nextRoute(s.item.route), owner: null, leaseUntil: null, status: 'open' },
  events: [{ kind: 'escalate', by: 'coordinator', detail: { from: s.item.route, to: nextRoute(s.item.route), note } }] });

/** Did the move take the plain return-claim outcome: not a review, not a stale release. */
const returnsClaim = (before, m) => !m.stale && before.item?.status !== 'submitted';

/**
 * The release rules over an injected reason list and stale-limit rule.
 * Snapshot: `{ revision, item, actor: { id, route, joined }, owner, diagnosed, firstRefusalBuilder, items, history, lastClaim, ownerLastClaimId, ownerLastLease, ownerRegisteredPath, io }`.
 * Move: `{ id, actor, root, reason, note, on, now, worktreeSnapshot, stale }`; `stale` is the coordinator's captured observation.
 * Why: each guard below is one fact, so its refusal, its trace and `pullboard explain` never drift apart.
 */
function releaseRules({ reasons, staleLimits }) {
  /** The first reason a coordinator's captured stale observation cannot release this claim, or null. */
  function staleProblem(s, m) {
    const c = m.stale, row = c.staleClaim, now = Date.parse(m.now);
    const observed = instant(c.observedAt, now);
    const last = observed === null ? null : instant(row?.lastActivity, observed);
    const limits = staleLimits({ health: c.health });
    const limit = row?.blocker === true ? limits.blocker : limits.claim;
    const folderGone = typeof row?.seatFolderMissing === 'string' && row.seatFolderMissing === s.ownerRegisteredPath;
    if (s.item.status !== 'claimed' || s.item.owner !== row?.actor || s.item.id !== row?.id || s.item.leaseUntil !== row?.leaseUntil
      || (c.leaseLapse !== true && !(s.item.leaseUntil > m.now)) || s.ownerLastClaimId !== row?.claimEventId || c.observedRevision !== s.revision) return STALE_CHANGED;
    if (!folderGone && (observed === null || last === null || row.evidence?.complete !== true || row.limitMs !== limit || observed - last < limit)) {
      return 'complete activity evidence does not establish the configured stale interval';
    }
    if (!folderGone && c.leaseLapse === true && s.item.leaseUntil <= m.now) {
      if (observed - Date.parse(s.item.leaseUntil) < limit) return 'the expired lease has not passed its configured stale interval; wait for that interval before releasing';
      const lease = s.ownerLastLease, leaseMs = Date.parse(s.item.leaseUntil) - Date.parse(lease?.at);
      if (!lease || lease.id !== row.leaseEventId || lease.at !== row.leaseStartedAt || row.leaseMs !== leaseMs || lease.leaseUntil !== row.leaseUntil
        || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) return 'the claim lease changed after the stale observation; capture it again';
    }
    return null;
  }
  const stale = (m) => Boolean(m.stale);
  return {
    staleProblem,
    rules: defineRules({
      checkoutMine: { says: 'the checkout is not bound to another agent session', holds: (s) => !s.io?.checkoutOwner },
      joined: { says: 'the caller is a joined seat', holds: (s) => s.actor?.joined !== false },
      onNeedsBlocked: { says: '--on is only used with an ordinary release naming BLOCKED', holds: (s, m) => m.on === undefined || (m.reason === 'BLOCKED' && !stale(m)) },
      onIsIds: { says: '--on, when given, names one or more local item ids', holds: (s, m) => m.on === undefined || (m.on.length > 0 && m.on.every(id => Number.isInteger(id))) },
      staleByCoordinator: { says: 'only the coordinator releases another holder with --stale', holds: (s, m) => !stale(m) || m.actor === 'coordinator' },
      staleReasonKnown: { says: 'a stale release names a reason from the fixed list', holds: (s, m) => !stale(m) || reasons.includes(m.reason) },
      staleDiagnosisNoted: { says: 'a stale wrong-diagnosis release says what was wrong', holds: (s, m) => !(stale(m) && m.reason === 'DIAGNOSIS_WRONG' && blank(m.note)) },
      staleOtherNoted: { says: 'a stale OTHER release carries its reason in the note', holds: (s, m) => !(stale(m) && m.reason === 'OTHER' && blank(m.note)) },
      staleNoted: { says: 'a stale release gives a one-line note', holds: (s, m) => !stale(m) || !(blank(m.note) || LINE_BREAK.test(m.note)) },
      staleObserved: { says: 'a stale release names the claim its observation captured', holds: (s, m) => !stale(m) || m.stale.staleClaim?.id === m.id },
      itemExists: { says: 'the item exists', holds: (s) => Boolean(s.item) },
      notHeldElsewhere: { says: 'a claim is released from the checkout that holds it',
        holds: (s, m) => stale(m) || !(s.item.status === 'claimed' && s.owner?.sameSession && s.owner.path !== m.root && m.root !== `${s.owner.path}-item-${m.id}`) },
      reasonKnown: { says: 'a release names a reason from the fixed list', holds: (s, m) => reasons.includes(m.reason) },
      diagnosisNoted: { says: 'a wrong-diagnosis release says what was wrong', holds: (s, m) => !(m.reason === 'DIAGNOSIS_WRONG' && blank(m.note)) },
      otherNoted: { says: 'an OTHER release carries its reason in the note', holds: (s, m) => !(m.reason === 'OTHER' && blank(m.note)) },
      reviewNoted: { says: 'releasing your review gives a one-line reason',
        holds: (s, m) => !(s.item.status === 'submitted' && s.item.reviewer === m.actor && (blank(m.note) || LINE_BREAK.test(trimmed(m.note)))) },
      onByHolder: { says: 'only the holder adds dependencies while releasing', holds: (s, m) => m.on === undefined || claimedByMe(s, m) },
      onFound: { says: '--on dependencies all exist', holds: (s, m) => m.on === undefined || dependencyProblem(s, m)?.code !== 'NO_ITEM' },
      onNotWithdrawn: { says: '--on waits on no withdrawn item', holds: (s, m) => m.on === undefined || dependencyProblem(s, m)?.code !== 'WITHDRAWN' },
      onNoCycle: { says: '--on makes no dependency cycle', holds: (s, m) => m.on === undefined || dependencyProblem(s, m)?.code !== 'DEPENDENCY_CYCLE' },
      diagnosisHeld: { says: 'a wrong-diagnosis release returns a diagnosed claim the caller holds', holds: (s, m) => m.reason !== 'DIAGNOSIS_WRONG' || Boolean(s.diagnosed && claimedByMe(s, m)) },
      staleValid: { says: 'a stale observation still matches the claim and proves its idle interval', holds: (s, m) => !stale(m) || staleProblem(s, m) === null },
      reviewMine: { says: 'a review is released only by its reviewer', holds: (s, m) => !(s.item.status === 'submitted' && s.item.reviewer !== m.actor) },
      claimMine: { says: 'a claim is released only by its holder, or inside its first-refusal window',
        holds: (s, m) => stale(m) || s.item.status === 'submitted' || claimedByMe(s, m) || (s.item.status === 'open' && s.firstRefusalBuilder === m.actor) },
      reviewing: { says: 'the item is submitted, so the release frees its review', holds: (s) => s.item?.status === 'submitted' },
      staleRelease: { says: 'the release is a coordinator --stale release', holds: (s, m) => stale(m) },
      calibrates: { says: 'a holder released BUDGET or INELIGIBLE at their own route',
        holds: (s, m) => returnsClaim(s.before, m) && chosenByHolder(s.before, m) && ['BUDGET', 'INELIGIBLE'].includes(m.reason) && s.before.actor?.route === s.before.item.route },
      releasedTwice: { says: 'this is the second chosen quality release since the last unhold or route change',
        holds: (s, m) => returnsClaim(s.before, m) && m.reason !== 'DIAGNOSIS_WRONG' && chosenByHolder(s.before, m)
          && QUALITY.includes(m.reason) && !s.before.item.holdReason && lastTwoChosen(s).length === 2 },
    }),
  };
}

/** The release table: guards in the order today's command throws, then the three outcomes and the two automatic follow-ups. */
function releaseTable({ reasons, staleLimits }, staleProblem) {
  const unknownReason = `a release names why: --reason ${reasons.join('|')} (OTHER also needs --note "what happened")`;
  const dependency = (s, m) => dependencyProblem(s, m)?.message ?? '';
  return Object.freeze({
    name: 'release',
    guards: Object.freeze([
      { id: 'checkout-is-mine', requires: 'checkoutMine', code: 'NOT_YOUR_CHECKOUT', message: (s) => `this checkout belongs to ${s.io.checkoutOwner} in another agent session`, next: 'continue in your own checkout: pullboard next' },
      { id: 'joined', requires: 'joined', code: 'NOT_JOINED', message: (s) => unjoined(s).message, next: (s) => unjoined(s).next },
      { id: 'on-needs-blocked', requires: 'onNeedsBlocked', code: 'USAGE', message: '--on requires an ordinary release with --reason BLOCKED', next: 'run pullboard help' },
      { id: 'on-is-ids', requires: 'onIsIds', code: 'BAD_DEPENDENCIES', message: '--on needs one or more local item ids', next: 'pass one or more existing local item ids with --on, or omit --on' },
      { id: 'stale-coordinator-only', requires: 'staleByCoordinator', code: 'NOT_YOURS', message: 'only the coordinator releases another holder with --stale', next: SHOUT },
      { id: 'stale-reason-known', requires: 'staleReasonKnown', code: 'RELEASE_REASON', message: unknownReason, next: REASON_NEXT },
      { id: 'stale-diagnosis-note', requires: 'staleDiagnosisNoted', code: 'DIAGNOSIS_WRONG', message: 'say what was wrong with --note so a capable seat can correct the diagnosis', next: DIAGNOSIS_NEXT },
      { id: 'stale-other-note', requires: 'staleOtherNoted', code: 'RELEASE_REASON', message: 'OTHER needs the reason in --note "what happened"', next: REASON_NEXT },
      { id: 'stale-note', requires: 'staleNoted', code: 'NOTE_REQUIRED', message: 'release a stale claim with --stale --note "why"', next: RELEASE_NEXT.NOTE_REQUIRED },
      { id: 'stale-observed', requires: 'staleObserved', code: 'NOT_YOURS', message: 'this item has no current claim to release as stale', next: SHOUT },
      { id: 'item-exists', requires: 'itemExists', code: 'NO_ITEM', message: (s, m) => `no item #${m.id}; see: pullboard list`, next: RELEASE_NEXT.NO_ITEM },
      { id: 'not-held-elsewhere', requires: 'notHeldElsewhere', code: 'NOT_YOURS', message: (s, m) => `#${m.id} is held by ${s.item.owner} in ${s.owner.path}, not by this checkout`,
        next: (s, m) => `release it from that seat's checkout: cd '${s.owner.path}' && pullboard release ${m.id}` },
      { id: 'reason-known', requires: 'reasonKnown', code: 'RELEASE_REASON', message: unknownReason, next: REASON_NEXT },
      { id: 'diagnosis-note', requires: 'diagnosisNoted', code: 'DIAGNOSIS_WRONG', message: 'say what was wrong with --note so a capable seat can correct the diagnosis', next: DIAGNOSIS_NEXT },
      { id: 'other-note', requires: 'otherNoted', code: 'RELEASE_REASON', message: 'OTHER needs the reason in --note "what happened"', next: REASON_NEXT },
      // Today this refusal is thrown before the move's next-step map applies, so its next step repeats the message.
      { id: 'review-note', requires: 'reviewNoted', code: 'NOTE_REQUIRED', message: 'give the review release a one-line reason with --note "..."', next: 'give the review release a one-line reason with --note "..."' },
      { id: 'on-claim-mine', requires: 'onByHolder', code: 'NOT_YOURS', message: (s, m) => `item #${m.id} is not claimed by you`, next: SHOUT },
      { id: 'on-found', requires: 'onFound', code: 'NO_ITEM', message: dependency, next: RELEASE_NEXT.NO_ITEM },
      { id: 'on-not-withdrawn', requires: 'onNotWithdrawn', code: 'WITHDRAWN', message: dependency, next: 'unobserved' },
      { id: 'on-no-cycle', requires: 'onNoCycle', code: 'DEPENDENCY_CYCLE', message: dependency, next: 'change --after so no item waits on itself' },
      { id: 'diagnosis-held', requires: 'diagnosisHeld', code: 'DIAGNOSIS_WRONG', message: 'claim a diagnosed item before returning it for a new diagnosis', next: DIAGNOSIS_NEXT },
      { id: 'stale-valid', requires: 'staleValid', code: 'NOT_YOURS', message: (s, m) => staleProblem(s, m), next: SHOUT },
      { id: 'review-mine', requires: 'reviewMine', code: 'NOT_YOURS',
        message: (s, m) => `item #${m.id} review is not reserved by you; ask its current reviewer to release it, or take a free review with pullboard next --verify`, next: SHOUT },
      { id: 'claim-mine', requires: 'claimMine', code: 'NOT_YOURS', message: (s, m) => `item #${m.id} is not claimed by you`, next: SHOUT },
    ]),
    outcomes: Object.freeze([
      { id: 'free-review', when: 'reviewing', patch: () => ({ reviewer: null }),
        events: (s, m) => [{ kind: 'release', by: m.actor, detail: { review: true, reason: trimmed(m.note), reasonCode: m.reason } }] },
      { id: 'release-stale', when: 'staleRelease', patch: () => ({ status: 'open', owner: null, leaseUntil: null }),
        events: (s, m) => {
          const record = staleRecord(s, m);
          return [{ kind: 'release', by: m.actor, detail: { staleClaim: record, reason: record.reason,
            ...(record.expiredClaim ? { expiredClaim: record.expiredClaim, reopenFirstRefusal: record.reopenFirstRefusal } : {}), reasonCode: m.reason } }];
        } },
      { id: 'return-claim',
        patch: (s, m) => ({ status: 'open', owner: null, leaseUntil: null, ...(m.on ? { after: combinedAfter(s, m) } : {}), ...(m.reason === 'DIAGNOSIS_WRONG' ? { route: 'mid' } : {}) }),
        events: (s, m) => [{ kind: 'release', by: m.actor, detail: { reasonCode: m.reason, ...(m.on ? { blockedOn: m.on } : {}),
          ...(untouched(s, m) ? { untouchedAutoClaim: true } : {}), ...(trimmed(m.note) ? { reason: trimmed(m.note) } : {}) } }] },
    ]),
    followups: Object.freeze([
      { id: 'route-calibration', when: 'calibrates',
        apply: ({ after, move: m }) => escalation(after, `${m.actor} released at the ${after.actor.route} route: ${m.reason}${trimmed(m.note) ? ` (${trimmed(m.note)})` : ''}`) },
      { id: 'released-twice', when: 'releasedTwice',
        apply: ({ after: s }) => {
          const reasons = listReasons(lastTwoChosen(s));
          if (['light', 'mid'].includes(s.item.route)) return escalation(s, `Released twice at the ${s.item.route} route: ${reasons}`);
          const reason = `Released twice: ${reasons}`;
          return { patch: { holdReason: reason, holdBy: 'coordinator' }, events: [{ kind: 'hold_item', by: 'coordinator', detail: { reason, automatic: 'release-twice' } }] };
        } },
    ]),
  });

  /** What a valid stale observation records about the holder it releases. */
  function staleRecord(s, m) {
    const c = m.stale, row = c.staleClaim, now = Date.parse(m.now);
    const limits = staleLimits({ health: c.health });
    const limit = row.blocker === true ? limits.blocker : limits.claim;
    const folderGone = typeof row.seatFolderMissing === 'string' && row.seatFolderMissing === s.ownerRegisteredPath;
    const lapsed = !folderGone && c.leaseLapse === true && s.item.leaseUntil <= m.now ? (() => {
      const leaseMs = Date.parse(s.item.leaseUntil) - Date.parse(s.ownerLastLease.at);
      return { expiredClaim: { holder: s.item.owner, leaseUntil: s.item.leaseUntil, lastActivity: row.lastActivity, observedAt: c.observedAt, leaseEventId: row.leaseEventId },
        reopenFirstRefusal: { builder: s.item.owner, until: new Date(now + leaseMs).toISOString() } };
    })() : {};
    return { holder: s.item.owner, lastActivity: row.lastActivity, observedAt: c.observedAt, claimEventId: row.claimEventId, limitMs: limit, ...lapsed, blocker: row.blocker === true,
      ...(folderGone ? { seatFolderMissing: s.ownerRegisteredPath, reason: `registered worktree no longer exists: ${s.ownerRegisteredPath}; ${trimmed(m.note)}` } : { reason: trimmed(m.note) }) };
  }
}

/**
 * Build the release rules and table over the board's own reason list and stale-limit rule, handed in by the caller.
 * Why: moves may not reach into the store, and the reasons and stale limits must stay one source; the caller passes store's
 * `RELEASE_REASONS` and `staleStateLimits`, so there is no second copy to drift (as hop.table.js takes the jobs lease rule).
 *
 * @param {{ reasons: readonly string[], staleLimits: (config: object) => { claim: number, blocker: number } }} board
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function releaseEngine(board) {
  if (!Array.isArray(board?.reasons) || !board.reasons.length || typeof board?.staleLimits !== 'function') {
    throw new Refused('RELEASE_TABLE_INPUTS', 'the release table needs the release reasons and the stale-limit rule', "pass RELEASE_REASONS and staleStateLimits from the store's front door");
  }
  const { rules, staleProblem } = releaseRules(board);
  return Object.freeze({ rules, table: releaseTable(board, staleProblem) });
}
