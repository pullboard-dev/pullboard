/** The verify move as one pure table: every rule the command and board enforce when a seat records an accept or reject, ported from the pure-core pilot [C7,#8248]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';
import { landingOf } from './rules.js';
import { VERIFY_NEXT } from './next.js';
export { VERIFY_NEXT } from './next.js';

const ROUTES = Object.freeze(['light', 'mid', 'strong']);
/** The paces under which a landed item takes no verdict: steady and strict land only verified work. */
const VERIFIED_PACES = Object.freeze(['steady', 'strict']);
/** The pace that lands submitted work before its verdict, so a landed item may still take one [V6]. */
const SPRINT_PACES = Object.freeze(['sprint']);
const SHOUT_LIMIT = 400;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Steps for codes the table refuses with that the live next-step map does not list (the command falls back to the step in the message). */
const EXTRA_NEXT = Object.freeze({
  USAGE: 'run pullboard help',
  SUBMISSION_PROOF: 'retain native source-matched proof receipts and submit again before verification',
  PROOF_RUN_UNBOUND: 'restore the native gate receipt; do not supply provenance by hand',
  SOURCE_ADVANCE_STALE: 'read the current item, bar, patches and main, then let the worker check the new exact composition',
});

/** The fixed words of the refusals the command raises itself before the board move, one place for the table and the command. */
export const VERIFY_WORDS = Object.freeze({
  usage: 'pullboard verify <id> accept, or reject --reason CODE --note "..."',
  selfVerify: 'the builder never verifies its own work; another agent must',
  criteriaMoved: 'the criterion changed; ask the coordinator to refreeze this item before checking it',
});

/** The fields the shell must read with io, and why. */
export const VERIFY_IO_FIELDS = Object.freeze({
  isMain: 'git: whether the caller runs in the main checkout (MAIN_IS_COORDINATOR)',
  mainRefusal: 'git + board: the MAIN_IS_COORDINATOR message and its reviewer start-up next step',
  selfSession: 'filesystem: the agent-session ledger says this session built or submitted the item (SELF_SESSION_VERIFY)',
  staleAcceptance: 'git: a verified, unlanded item whose accepted composition is stale, so it may be re-reviewed',
  policyRefused: 'git: the item policy (pullboard.json at the frozen commit) cannot be read, {code, message} or null (NO_POLICY / BAD_CONFIG)',
  commitInHead: 'git: the submitted commit resolves and is contained in the reviewer HEAD (NOT_AT_COMMIT)',
  root: 'process: the checkout root named in the NOT_AT_COMMIT step',
  missingCompanions: 'git: companion keys the review tree lacks, {keys, digest} or null (NOT_AT_COMMIT)',
  checkRefused: 'git + process: the accept path (compose, frozen check, trunk moves, stacks) refused, {code, message, next} or null',
  selectorGap: 'git + process: the red frozen check filed a selector gap instead of a verdict',
  reviewHolderFresh: 'local presence: the review holder heartbeat is younger than the reservation timeout',
  notJoined: "git + board: the NOT_JOINED wording, which lists this session's seats and their checkouts",
});

/** Board-data rules the table takes precomputed by the shell, which runs today's functions for them. */
export const VERIFY_DEFERRED_FIELDS = Object.freeze({
  environmentProblem: 'a recorded environment names exact platform, arch and Node (VERDICT_ENVIRONMENT)',
  knownMainProblem: 'known main failures are well formed and owned (SUBMISSION_PROOF)',
  quarantineProblem: "the quarantine proof is bound, green and the caller's (PROOF_RUN_UNBOUND)",
  gateReceipt: 'the submit hand-off has a captured proof receipt (GATE_PENDING)',
  companionWindow: 'automatic companions are past their objection window (COMPANION_WINDOW)',
  authorProblem: 'parent sessions, strict touch and linked standing beyond the built-by rule (SELF_SESSION_VERIFY)',
  requiredFamily: 'the item review-family requirement against the declared family (REQUIRED_REVIEW_FAMILY)',
  familyProblem: 'the vendor family policy under two-tier review (O2_FAMILY_MATCH)',
  patchProblem: 'an accept binds the current companion patch set (ITEM_PATCH_CHANGED)',
  sandboxProblem: 'an outside accept carries its sandbox receipt (CHECK_RED)',
  relaxation: 'a relaxed review-family reservation appends its note line',
  assurance: 'verdict assurance from agent parent sessions',
  impliedFacts: 'the facts a verdict with --implies writes',
});

/**
 * The step a refusal message already spells out: the command prints it as the next step whenever the raise site passed none.
 * Why: this keeps the table's refusals worded as the command words them.
 *
 * @param {unknown} message
 * @returns {string | undefined}
 */
export function stepInMessage(message) {
  const line = String(message).split('\n')[0];
  const match = /(?:^|; |\. |: )((?:run|install|upgrade|fix|restore|commit|merge|test|check out|set|give|use|reject|ask your coordinator|answer from the main checkout|the coordinator(?= (?:runs?|sets?|restores?|either|must)\b)|to keep looking|never work around)\b.*)/i.exec(line);
  return match?.[1] && !/--reason\s+CODE\b/u.test(match[1]) ? match[1] : undefined;
}

const isAccept = (m) => m.decision === 'ACCEPT';
/** The item's landing value from its merged commit and its landing events. */
const landing = (s) => landingOf(s.item, s.history);
const noteOf = (m) => String(m.note ?? '');
const textOf = (value, s, m) => (typeof value === 'function' ? value(s, m) : value);
const cdTo = (path) => `cd ${/^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replace(/'/gu, `'\\''`)}'`} &&`;

/** Whether a sealed review binds the submitted commit, its checked head, a trunk and sorted unique paths. */
function reviewValid(review, commit) {
  return Boolean(review) && typeof review === 'object' && !Array.isArray(review)
    && Object.keys(review).sort().join(',') === 'commit,head,paths,trunk' && SHA.test(review.head ?? '')
    && review.commit === commit && SHA.test(review.commit ?? '') && SHA.test(review.trunk ?? '')
    && Array.isArray(review.paths) && review.paths.every(path => typeof path === 'string' && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..'))
    && JSON.stringify(review.paths) === JSON.stringify([...new Set(review.paths)].sort());
}

/** The frozen verify policy the board replays with, or null when missing or invalid. */
function frozenPolicy(s) {
  let frozen;
  try { frozen = JSON.parse(s.item.frozen ?? 'null'); } catch { return null; }
  const p = frozen?.policy;
  return p?.version === 1 && /^[0-9a-f]{40,64}$/.test(p.commit ?? '') && ['any', 'coordinator'].includes(p.verify?.policy) && ['off', 'prefer', 'require'].includes(p.verify?.family) ? p.verify : null;
}

/** Committed authors under two-tier review: the builder and every submitter of an exact commit. */
const authors = (s) => [...new Set([s.item.builtBy, ...s.history.filter(e => e.kind === 'submit' && SHA.test(e.detail.commit ?? '')).map(e => e.by)].filter(Boolean))];
const reviewHolder = (s) => (s.item.status === 'submitted' && s.item.reviewBy && (s.item.reviewUntil ?? '') > s.now && s.io.reviewHolderFresh !== false ? s.item.reviewBy : null);

/**
 * Build the verify rules and table over the board's own reason lists and bar readers, handed in by the caller.
 * Why: moves may not reach into the store or the verify package, and the reasons, cause keys and bar reading must stay one
 * source; the caller passes the live ones, so there is no second copy to drift (as release.table.js takes the release reasons).
 *
 * @param {{ acceptReason: string, rejectReasons: readonly string[], wording: (value: unknown) => string,
 *   frozenBar: (frozenText: string) => object, namedClause: (bar: object, quote: string) => string | null,
 *   causeProblem: (cause: unknown) => { message: string } | null, pipelineCause: (input: object) => object,
 *   strongNoticeEngine: number }} board
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function verifyEngine(board) {
  const need = ['wording', 'frozenBar', 'namedClause', 'causeProblem', 'pipelineCause'];
  if (typeof board?.acceptReason !== 'string' || !Array.isArray(board?.rejectReasons) || !board.rejectReasons.length
    || !Number.isInteger(board?.strongNoticeEngine) || need.some(name => typeof board?.[name] !== 'function')) {
    throw new Refused('VERIFY_TABLE_INPUTS', 'the verify table needs the verdict reasons, the bar readers, the cause rules and the strong-notice engine',
      "pass ACCEPT_REASON, REJECT_REASONS, the frozen-bar readers, causeProblem, pipelineCause and STRONG_REJECTION_NOTICE_ENGINE from the packages' front doors");
  }
  const { acceptReason, rejectReasons, wording, frozenBar, namedClause, causeProblem, pipelineCause, strongNoticeEngine } = board;
  const clauseOf = (s, m) => namedClause(frozenBar(s.item.frozen), wording(m.clause));

  /** The clause binding a reject records. */
  function clauseDetail(s, m) {
    const bar = frozenBar(s.item.frozen);
    return { clause: wording(m.clause), clauseText: namedClause(bar, wording(m.clause)), barKey: createHash('sha256').update(JSON.stringify(bar)).digest('hex') };
  }
  /** The note the board records: the command's note plus a relaxed reservation's line. */
  const fullNote = (s, m) => noteOf(m) + (s.deferred.relaxation ? `\n${s.deferred.relaxation}` : '');

  /** The rigor cause of a reject: the one given, else the actor's recorded failing test, else its verdict reason. */
  function derivedCause(s, m) {
    if (m.cause !== undefined && m.cause !== null) return { cause: m.cause };
    const submitted = s.history.findLast(e => e.kind === 'submit')?.id ?? 0;
    const failure = s.actorFlakeObservations.findLast(e => e.id > submitted && e.detail.engine === s.nativeFlakeEngine && e.detail.observation?.kind === 'verify'
      && e.detail.observation.head === s.item.commit && e.detail.observation.original?.green === false && typeof e.detail.observation.file === 'string'
      && typeof e.detail.observation.name === 'string' && causeProblem(`test:${e.detail.observation.file}::${String(e.detail.observation.name).trim()}`) === null);
    if (failure) return { cause: `test:${failure.detail.observation.file}::${String(failure.detail.observation.name).trim()}`, causeDerivation: { kind: 'recorded-failure', event: failure.id } };
    return { cause: `refusal:${m.reason ?? 'REOPENED'}`, causeDerivation: { kind: m.reason ? 'verdict-reason' : 'reopen-category', coarse: true } };
  }

  /** The accept or reject event detail, key for key as the board writes it. */
  function verdictDetail(s, m) {
    const accept = isAccept(m);
    const code = accept ? acceptReason : m.reason;
    const full = fullNote(s, m);
    const cause = accept ? {} : derivedCause(s, m);
    const detail = { ...(accept ? {} : { pipelineCause: pipelineCause({ ...cause, reason: code, note: full }) }), reason: code, commit: s.item.commit, ...cause,
      ...(accept ? {} : clauseDetail(s, m)), ...(m.companionDigest ? { companionDigest: m.companionDigest } : {}),
      ...(m.itemReviewPolicy ? { policy: m.itemReviewPolicy } : {}) };
    if (accept) detail.note = full.trim();
    if (accept && m.check !== undefined) detail.check = m.check;
    if (accept && m.knownMainFailures !== undefined) detail.knownMainFailures = m.knownMainFailures;
    if (accept && m.quarantineProofId !== undefined) detail.quarantineProofId = m.quarantineProofId;
    if (m.environment !== undefined) detail.environment = m.environment;
    if (m.sandbox !== undefined) detail.sandbox = m.sandbox;
    detail.review = { commit: m.review.commit, head: m.review.head, trunk: m.review.trunk, paths: [...m.review.paths] };
    return m.implies?.length ? { ...detail, implies: m.implies } : detail;
  }

  /** The item fields and the verdict row a verdict writes. */
  function verdictPatch(s, m) {
    const accept = isAccept(m);
    return { status: accept ? 'verified' : 'open', verdict: m.decision, verifiedBy: accept ? m.actor : null, owner: accept ? s.item.owner : null,
      verdictRow: { id: s.nextVerdictId, item: s.item.id, by: m.actor, decision: m.decision, reason: accept ? acceptReason : m.reason, note: fullNote(s, m).trim(),
        commit: s.item.commit, digest: m.digest, head: m.head, family: s.actor.family ?? null, at: s.now },
      ...(s.deferred.assurance ? { meta: { [`verdict_assurance:${s.nextVerdictId}`]: s.deferred.assurance } } : {}) };
  }

  /** The item's history and verdict rows with this reject in them, at the ids the board assigns. */
  const withThis = (s, m) => ({ history: [...s.before.history, { id: s.before.nextEventId, kind: 'reject', detail: clauseDetail(s.before, m) }],
    verdicts: [...s.before.verdicts, s.item.verdictRow] });

  /** Whether this reject is the second of the same clause on the same bar, with no sharpen yet. */
  function sharpenDue(s, m) {
    const d = clauseDetail(s, m);
    if (!d.clause) return false;
    const bar = frozenBar(s.item.frozen);
    const same = [...s.history, { kind: 'reject', detail: d }].filter(e => ['reject', 'bar-sharpen'].includes(e.kind) && e.detail.barKey === d.barKey && namedClause(bar, e.detail.clause ?? '') === d.clauseText);
    return same.filter(e => e.kind === 'reject').length === 2 && !same.some(e => e.kind === 'bar-sharpen');
  }

  /** Rejections since the item's last route change, as the escalation receipts list them. */
  function rejectionsSinceRouteChange(after) {
    let last = -1;
    after.history.forEach((e, i) => {
      if (e.kind === 'escalate' || (e.kind === 'strong-rejection-notice' && e.detail.engine === strongNoticeEngine) || (e.kind === 'edit' && Object.hasOwn(e.detail, 'route'))) last = i;
    });
    const byEvent = new Map(after.history.filter(e => ['accept', 'reject'].includes(e.kind)).map((e, i) => [e.id, after.verdicts[i]]));
    return after.history.slice(last + 1).flatMap(e => {
      const v = e.kind === 'reject' ? byEvent.get(e.id) : null;
      return v && v.decision === 'REJECT' ? [{ eventId: e.id, verdictId: v.id, by: v.by, reason: v.reason, note: v.note, commit: v.commit, digest: v.digest, head: v.head, at: v.at }] : [];
    });
  }

  /** The escalate move a rejection triggers: one route up (strong stays strong), the owner and lease cleared. */
  function escalation(s, { note: text, rejections }) {
    const from = s.item.route, to = ROUTES[Math.min(ROUTES.indexOf(from) + 1, ROUTES.length - 1)];
    return { patch: { route: to, owner: null, leaseUntil: null }, events: [{ kind: 'escalate', by: 'coordinator', detail: { from, to, note: text.trim(), ...(rejections ? { rejections } : {}) } }] };
  }

  /** Quote the clause whole when the notice fits a shout; otherwise keep its start. */
  function sharpenText(id, clause) {
    const text = (quoted) => `#${id} needs a sharper bar after two rejects of “${quoted}”. Clarify the criterion, refreeze it, and lift the item hold before another build round.`;
    if (text(clause).length <= SHOUT_LIMIT) return text(clause);
    const tail = `… (+${clause.length} characters; pullboard show ${id})`;
    const kept = clause.slice(0, SHOUT_LIMIT - text('').length - tail.length);
    return text(`${kept}… (+${clause.length - kept.length} characters; pullboard show ${id})`);
  }

  const calibrates = (s, m) => !isAccept(m) && m.reason === 'TEST_FAILURE' && s.actor.route === s.item.route;
  const rules = {};
  const guards = [];
  /** One guard row and its rule together, so the refusal and the fact it reads can never drift apart; `refuses` is the rule's negation. */
  const guard = (id, code, says, refuses, message, extra = {}) => {
    rules[id] = { says, holds: (s, m) => !refuses(s, m) };
    guards.push({ id, requires: id, code, message, next: extra.next ?? ((s, m) => stepInMessage(textOf(message, s, m)) ?? VERIFY_NEXT[code] ?? EXTRA_NEXT[code] ?? 'run pullboard help'),
      ...(extra.codeOf ? { codeOf: extra.codeOf } : {}), ...(extra.paces ? { paces: extra.paces } : {}) });
  };
  /** A rule the shell decided with its own functions: the guard refuses with the code and words the shell hands in. */
  const fromShell = (id, where, key, says, code, applies = () => true) => guard(id, code, says, (s, m) => applies(m) && Boolean(s[where][key]), (s) => s[where][key].message,
    { codeOf: (s) => s[where][key].code ?? code, next: (s) => s[where][key].next ?? VERIFY_NEXT[s[where][key].code ?? code] ?? EXTRA_NEXT[s[where][key].code ?? code] ?? 'run pullboard help' });

  // The command's preconditions, in the order it runs them.
  guard('decision-known', 'USAGE', 'the verdict is accept or reject', (s, m) => !['ACCEPT', 'REJECT'].includes(m.decision), VERIFY_WORDS.usage);
  guard('as-coordinator-only', 'USAGE', '--as names only the coordinator', (s, m) => m.as !== undefined && m.as !== 'coordinator', '--as takes one value: coordinator');
  guard('as-main-only', 'USAGE', '--as works only in the main checkout', (s, m) => !s.io.isMain && Boolean(m.as), '--as coordinator works only in the main checkout; here you are the agent this worktree joined as');
  guard('main-is-coordinator', 'MAIN_IS_COORDINATOR', "a verdict from the main checkout is the coordinator's and says so", (s, m) => s.io.isMain && m.as !== 'coordinator',
    (s) => s.io.mainRefusal?.message, { next: (s) => s.io.mainRefusal?.next });
  guard('joined', 'NOT_JOINED', 'the caller is a joined seat', (s) => !s.actor.joined, (s) => s.io.notJoined?.message ?? 'this checkout has not joined a lane',
    { next: (s) => s.io.notJoined?.next ?? VERIFY_NEXT.NOT_JOINED });
  guard('item-exists', 'NO_ITEM', 'the item exists', (s) => !s.item, (s, m) => `no item #${m.id}; see: pullboard list`);
  guard('self-session', 'SELF_SESSION_VERIFY', 'the session that built the item never reviews it under another seat', (s) => Boolean(s.io.selfSession),
    (s, m) => `this agent session built or submitted #${m.id}, so its verdict would be its own work under another seat's name`, { next: VERIFY_NEXT.SELF_SESSION_VERIFY });
  guard('submitted', 'NOT_SUBMITTED', 'only submitted work, or a stale unlanded acceptance, takes a verdict',
    (s) => s.item.status !== 'submitted' && !(s.item.status === 'verified' && !s.item.merged && s.io.staleAcceptance), (s, m) => `item #${m.id} is ${s.item.status}, not submitted`);
  guard('implied-items-exist', 'NO_ITEM', 'every implied item exists', (s, m) => (m.implies ?? []).some(id => !s.knownItems.includes(id)),
    (s, m) => `no item #${m.implies.find(id => !s.knownItems.includes(id))} to imply; name items from pullboard list --all`);
  fromShell('item-policy', 'io', 'policyRefused', 'the item policy is readable', 'NO_POLICY');
  guard('at-submitted-commit', 'NOT_AT_COMMIT', 'the submitted commit is at or under the reviewer HEAD', (s) => s.io.commitInHead === false,
    (s) => `check out the submitted commit first: ${cdTo(s.io.root)} git switch --detach ${s.item.commit.slice(0, 12)}`);
  guard('companions-present', 'NOT_AT_COMMIT', 'the review tree holds every companion of the patch set', (s) => Boolean(s.io.missingCompanions?.keys?.length),
    (s, m) => `the review tree lacks companions ${s.io.missingCompanions.keys.join(', ')} for patch-set ${s.io.missingCompanions.digest}; run pullboard next --verify ${m.id} to check out the composed source`);
  guard('accept-criterion-current', 'CRITERIA_CHANGED', 'an accept checks the bar frozen at claim, never a moved one', (s, m) => isAccept(m) && m.digest !== s.item.frozenDigest, VERIFY_WORDS.criteriaMoved);
  fromShell('accept-check', 'io', 'checkRefused', "an accept's frozen check, composition and trunk moves pass", 'CHECK_RED', isAccept);
  // The ordered board move, in order.
  guard('frozen-policy', 'NO_POLICY', 'the item carries a valid frozen verify policy', (s) => frozenPolicy(s) === null,
    'the frozen verify policy is missing or invalid; ask the coordinator to refreeze this item before verifying it');
  fromShell('environment-shape', 'deferred', 'environmentProblem', 'a recorded environment names exact platform, arch and Node', 'VERDICT_ENVIRONMENT');
  guard('known-main-binds', 'SUBMISSION_PROOF', 'known main failures ride only an accept, on its review trunk',
    (s, m) => m.knownMainFailures !== undefined && (!isAccept(m) || !m.review || m.knownMainFailures.main !== m.review.trunk), 'known main failures must match the accepting review trunk');
  fromShell('known-main-owned', 'deferred', 'knownMainProblem', 'known main failures are well formed and owned by open repairs', 'SUBMISSION_PROOF');
  guard('quarantine-accept-only', 'PROOF_RUN_UNBOUND', 'quarantine proof authority rides only an accept', (s, m) => m.quarantineProofId !== undefined && !isAccept(m),
    'quarantine proof authority only accompanies an accepting verdict');
  fromShell('quarantine-bound', 'deferred', 'quarantineProblem', "a quarantine proof is bound, green and the caller's", 'PROOF_RUN_UNBOUND');
  fromShell('gate-receipt', 'deferred', 'gateReceipt', 'the submitted head has a captured gate proof receipt', 'GATE_PENDING');
  guard('source-advance-current', 'SOURCE_ADVANCE_STALE', 'the verdict binds the effective head its check ran on',
    (s, m) => (s.item.effectiveHead ?? null) !== (m.sourceAdvanceHead ?? null) && (s.item.effectiveHead !== null || m.sourceAdvanceHead !== undefined),
    'read the current effective source and rerun its exact frozen check before recording a verdict');
  guard('not-merged', 'ALREADY_MERGED', 'a landed item takes no new verdict', (s) => Boolean(s.item.merged), (s, m) => `item #${m.id} already landed; only unlanded acceptances can be re-reviewed`,
    { paces: VERIFIED_PACES });
  // Sprint lands submitted work first, so a landed item still takes its verdict; only a published item, or one verified and landed, is past review [V6,#8868].
  guard('sprint-not-final', 'ALREADY_MERGED', 'under sprint a landed item takes its verdict until it is published, or verified and landed',
    (s) => landing(s) === 'published' || (s.item.status === 'verified' && landing(s) === 'landed'),
    (s, m) => `item #${m.id} is ${landing(s) === 'published' ? 'published' : 'verified and landed'}; only work not yet past review takes a verdict`, { paces: SPRINT_PACES });
  guard('review-recorded', 'BAD_VERDICT_REVIEW', 'the review binds the submitted commit, its checked head, trunk and sorted paths', (s, m) => !reviewValid(m.review, s.item.commit),
    'the review must bind the current submitted commit, its checked commit, reviewed trunk and sorted unique candidate paths; use current Pullboard to review it again');
  fromShell('companion-window', 'deferred', 'companionWindow', 'automatic companions are past their objection window', 'COMPANION_WINDOW');
  guard('not-builder', 'SELF_VERIFY', 'no author of the item verifies it', (s, m) => authors(s).includes(m.actor), VERIFY_WORDS.selfVerify);
  fromShell('author-independence', 'deferred', 'authorProblem', 'the reviewer shares no parent session with an author, never wrote a strict item, and has standing', 'SELF_SESSION_VERIFY');
  guard('route-allows', 'ROUTE', 'the reviewer route covers the item route', (s) => ROUTES.indexOf(s.item.route) > ROUTES.indexOf(s.actor.route),
    (s) => `item #${s.item.id} needs a ${s.item.route} verifier; you joined on the ${s.actor.route} route`);
  guard('policy-allows', 'COORDINATOR_VERIFIES', "under verify: coordinator, lane work is the coordinator's",
    (s, m) => frozenPolicy(s).policy === 'coordinator' && s.item.lane !== 'coordinator' && m.actor !== 'coordinator', 'this repo has the coordinator verify lane work');
  fromShell('required-family', 'deferred', 'requiredFamily', 'a required reviewer family matches the declared family', 'REQUIRED_REVIEW_FAMILY');
  fromShell('family-allows', 'deferred', 'familyProblem', 'the vendor family policy allows this reviewer', 'O2_FAMILY_MATCH');
  guard('review-free', 'REVIEW_HELD', 'no other agent holds the review under a live lease', (s, m) => reviewHolder(s) !== null && reviewHolder(s) !== m.actor,
    (s) => `${s.item.reviewBy} holds the review of #${s.item.id} until ${s.item.reviewUntil}; take another: pullboard next --verify`);
  guard('criterion-unchanged', 'CRITERIA_CHANGED', 'the verdict binds the digest frozen at claim', (s, m) => m.digest !== s.item.frozenDigest,
    (s, m) => `the criterion for #${m.id} changed after it was claimed; the coordinator runs: pullboard refreeze ${m.id}`);
  fromShell('patch-review', 'deferred', 'patchProblem', 'an accept binds the current companion patch set', 'ITEM_PATCH_CHANGED');
  guard('reason-is-met', 'BAD_REASON', 'an accept gives the accept reason', (s, m) => isAccept(m) && Boolean(m.reason) && m.reason !== acceptReason,
    `accept means ${acceptReason}; a failed criterion is a reject`);
  fromShell('outside-sandbox', 'deferred', 'sandboxProblem', 'an outside accept carries its sandbox receipt', 'CHECK_RED');
  guard('proof-noted', 'PROOF_REQUIRED', 'an accept says how it was proved (the note as sent, machine lines included)', (s, m) => isAccept(m) && !noteOf(m).trim(),
    'an accept says how you proved it: --note "what you broke or which edge you tried, and what happened"; passing tests alone are not proof');
  guard('reason-coded', 'BAD_REASON', 'a reject names one of the reject reasons', (s, m) => !isAccept(m) && !rejectReasons.includes(m.reason), `a reject names one of: ${rejectReasons.join(', ')}`);
  guard('note-given', 'NOTE_REQUIRED', 'a reject says what failed', (s, m) => !isAccept(m) && !noteOf(m).trim(), 'a reject says what failed: --note "..."');
  guard('cause-well-formed', 'BAD_CAUSE', 'a cause, when given, is a cause key', (s, m) => !isAccept(m) && causeProblem(m.cause) !== null, (s, m) => causeProblem(m.cause).message);
  guard('clause-given', 'BAR_CLAUSE_REQUIRED', 'a reject names the failing frozen clause', (s, m) => !isAccept(m) && !(typeof m.clause === 'string' && m.clause.trim()),
    'a reject names the failing frozen bar clause', { next: VERIFY_NEXT.BAR_CLAUSE_REQUIRED });
  guard('clause-known', 'BAR_CLAUSE_UNKNOWN', 'the quote identifies exactly one frozen clause', (s, m) => !isAccept(m) && (wording(m.clause).length > 4096 || clauseOf(s, m) === null),
    'the rejection quote does not identify one frozen bar clause', { next: (s, m) => `read pullboard show ${m.id}, then quote the failing requirement with --clause` });

  Object.assign(rules, {
    accepts: { says: 'the verdict is an accept', holds: (s, m) => isAccept(m) },
    selectorGap: { says: 'the red frozen check filed a selector gap instead of an accept', holds: (s, m) => isAccept(m) && Boolean(s.io.selectorGap) },
    rejects: { says: 'the verdict is a reject', holds: (s, m) => !isAccept(m) },
    barSharpens: { says: 'this is the second reject of the same clause of the same bar, with no sharpen yet', holds: (s, m) => !isAccept(m) && sharpenDue(s.before, m) },
    routeCalibrates: { says: "a TEST_FAILURE reject by a seat on the item's own route", holds: (s, m) => calibrates(s.before, m) },
    twoRejects: { says: 'two rejects since the last route change, with no calibration this move',
      holds: (s, m) => !isAccept(m) && !calibrates(s.before, m) && rejectionsSinceRouteChange(withThis(s, m)).length >= 2 },
    impliesFacts: { says: 'the verdict names implied items whose facts it writes', holds: (s) => Boolean(s.deferred.impliedFacts?.length) },
    rejectsLanded: { says: 'the verdict is a reject of an item that has landed', holds: (s, m) => !isAccept(m) && landing(s.before) === 'landed' },
  });

  const table = Object.freeze({
    name: 'verify',
    guards: Object.freeze(guards),
    outcomes: Object.freeze([
      { id: 'selector-gap', when: 'selectorGap', patch: () => ({}), events: () => [] },
      { id: 'accept', when: 'accepts', patch: verdictPatch, events: (s, m) => [{ kind: 'accept', by: m.actor, detail: verdictDetail(s, m) }] },
      { id: 'reject', patch: verdictPatch, events: (s, m) => [{ kind: 'reject', by: m.actor, detail: verdictDetail(s, m) }] },
    ]),
    followups: Object.freeze([
      { id: 'bar-sharpen', when: 'barSharpens',
        apply: ({ before: s, move: m }) => {
          const d = clauseDetail(s, m);
          const to = s.lineSettings.sharpenToPerson === true ? 'person' : 'coordinator';
          const reason = `The bar needs sharpening after two rejects of: ${d.clauseText}`;
          return { patch: { holdReason: reason }, events: [{ kind: 'hold_item', by: 'coordinator', detail: { reason } },
            { kind: 'bar-sharpen', by: 'coordinator', detail: { ...d, to, digest: s.item.frozenDigest } },
            { kind: 'shout', item: null, by: to === 'person' ? 'coordinator' : 'sentinel', detail: { to, lanes: ['coordinator'], decision: to === 'person', text: sharpenText(s.item.id, d.clauseText) } }] };
        } },
      { id: 'route-calibration', when: 'routeCalibrates',
        apply: ({ before: s, move: m }) => escalation(s, { note: `${m.actor} rejected at the ${s.actor.route} route: ${m.reason} (${fullNote(s, m).trim()})` }) },
      { id: 'two-rejects', when: 'twoRejects',
        apply: ({ before: s, move: m, after }) => {
          const rejections = rejectionsSinceRouteChange(withThis({ before: s, item: after.item }, m)).slice(-2);
          if (s.item.route !== ROUTES.at(-1)) return escalation(s, { note: `Two REJECT verdicts at the ${s.item.route} route`, rejections });
          const builder = s.item.builtBy ?? s.item.owner;
          return { patch: {}, events: [{ kind: 'strong-rejection-notice', by: 'coordinator', detail: { engine: strongNoticeEngine, route: s.item.route, builder, rejections } },
            { kind: 'shout', item: null, by: 'sentinel', detail: { to: 'coordinator', lanes: ['coordinator'], text: `#${s.item.id} has two send-backs at the strongest route; ${builder} built it. Rejections: ${rejections.map(r => `#${r.verdictId} (${r.reason})`).join(', ')}.` } }] };
        } },
      { id: 'implied-facts', when: 'impliesFacts', apply: ({ before: s }) => ({ patch: {}, events: s.deferred.impliedFacts }) },
      // A reject of landed sprint work queues its pull-out; the item reopens for its builder with landing pulling until the revert is recorded [V6,M2,#8868].
      { id: 'pull-out', when: 'rejectsLanded', paces: SPRINT_PACES,
        apply: ({ before: s, move: m }) => ({ patch: {}, events: [{ kind: 'pull_out', by: 'coordinator',
          detail: { commit: s.item.commit, ...(s.item.mergedCommit ? { mergedCommit: s.item.mergedCommit } : {}), builder: s.item.builtBy ?? s.item.owner ?? null,
            verdict: s.nextVerdictId, reason: m.reason } }] }) },
    ]),
  });
  return Object.freeze({ rules: defineRules(rules), table });
}
