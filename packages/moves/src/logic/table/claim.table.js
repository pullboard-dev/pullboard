/** The claim and renew move as one pure table: every rule the board and CLI enforce when a seat claims or renews an item, ported from the pure-core pilot [C7,#8241]. */
import { Refused } from '../../../../kernel/light.js';
import { missingNeeds } from '../../../../queue/light.js';
import { defineRules } from './rules.js';
import { CLAIM_NEXT } from './next.js';
export { CLAIM_NEXT } from './next.js';

const ROUTES = Object.freeze(['light', 'mid', 'strong']);
/** Live claims one seat may hold at all, whatever N the board sizes for top-level item-folder claims. */
const LIVE_CLAIM_CAP = 10;

const help = (code) => CLAIM_NEXT[code] ?? 'run pullboard help';

/**
 * What the shell reads before the move runs, because it needs git, the filesystem, the process or another board; the table only reads the answers.
 * Why: the split between pure rules and io stays written down, so a replay knows which inputs it must rebuild or take from the record.
 */
export const CLAIM_IO = Object.freeze({
  checkoutOwner: 'session binding: the seat this checkout is bound to in another agent session, else null (NOT_YOUR_CHECKOUT)',
  coordinatorPaths: "git: bar paths no lane owns in the committed pullboard.json, with coordinatorPathsNext (CROSS_OWNERSHIP)",
  provesNothing: 'git + process: the check is already green on main (CRITERION_PROVES_NOTHING)',
  policyRefresh: 'git: null, { refused }, or the refreeze; { before, after, changed } when it names what changed',
  reworkWindows: 'git: accepted takeover and maintenance windows for returned rework (NO_POLICY)',
  exitCeiling: 'process: native context-ceiling counters when exit rules are on',
  ledgerWritable: 'filesystem: the agent-session ledger is writable (SESSION_LEDGER)',
  sessionCap: 'env: PULLBOARD_MODEL caps the seat route',
  sessionSeats: "session binding: this session's seats in other checkouts (NOT_JOINED guidance)",
  laneSeat: "git + filesystem: a free seat of this session in the item's lane (WRONG_LANE guidance)",
  primaryRoot: 'git: the primary checkout, named when no lane seat is free',
  foreignBlocker: 'another board: the first unlanded cross-repo dependency (BLOCKED)',
  takeoverReady: 'board: the line takeover wait (line.takeoverMinutes) has passed for this returned item, which ends its first-refusal window',
  builderGone: "heartbeats: the first-refusal builder's seat is gone, which ends its window early",
  buildBudgetMinutes: 'git: accepted itemBuildBudgetMinutes (default 30)',
  seatCap: 'runners + settings: { n, how }, the N top-level item-folder claims a seat may hold, sealed into the claim',
  freeze: 'filesystem + git: the criterion freeze, { text, digest } or { refused: { code, message } }',
  head: 'git: HEAD of the claiming checkout',
  autoNextSnapshot: 'git + filesystem: the worktree digest when next auto-claims',
});

/** Board facts the table takes precomputed, each a refusal `{ code, message }` or null, because today's functions decide them. */
const DEFERRED_CODES = Object.freeze({
  barProblem: ['UNDECLARED_BUILDER_FAMILY', 'BAR_NOT_READY'],
  reworkRouting: ['REOPEN_HELD_FOR_BUILDER', 'NO_POLICY'],
});
/** Codes a criterion freeze can refuse with, in the order the freeze can meet them. */
const FREEZE_CODES = Object.freeze(['UNKNOWN_SPEC', 'A5_GRAMMAR_VERSION', 'NO_POLICY', 'BAD_CONFIG', 'AGENT_APPROVAL_REQUIRED', 'BAR_NOT_READY', 'BAR_EMPTY']);

const leaseLive = (s, item) => item.status === 'claimed' && ((item.leaseUntil ?? '') > s.now || item.gateInFlight === true);
const isRenewal = (s, m) => s.item.owner === m.actor && leaseLive(s, s.item);
/** A child is free only beside its own parent, the sub-agent case; a child of a parent this seat does not hold counts like a top-level claim (#10846). */
const freeChild = (s, parentId) => parentId !== null && s.actorClaims.some(c => c.id === parentId && c.leaseUntil > s.now);
const isRework = (s, m) => s.item.verdict === 'REJECT' && s.item.builtBy === m.actor;
const routeIndex = (route) => ROUTES.indexOf(route);
const cappedRoute = (route, cap) => (cap && routeIndex(cap) < routeIndex(route) ? cap : route);
const seatRoute = (s, m) => cappedRoute(s.actor.route ?? 'strong', m.routeCap ?? s.io.sessionCap ?? null);
const adopts = (s, m) => m.adoptCorrection === true && pendingRefreeze(s).length > 0;
const refreshes = (s, m) => Boolean(s.io.policyRefresh && !s.io.policyRefresh.refused) && !adopts(s, m);
/** Whether the criterion freezes: the first claim, an adopted correction, or a lane-policy refresh. */
const freezes = (s, m) => s.item.frozenDigest === null || adopts(s, m) || refreshes(s, m);
/** The N a new top-level item-folder claim is held to, or null when the claim is not one. */
const seatCapFor = (s, m) => (!isRenewal(s, m) && m.itemFolder === true && !freeChild(s, s.item.parentId) && !isRework(s, m) ? s.io.seatCap ?? null : null);

/** Fields of an unadopted coordinator correction since the last refreeze. */
export function pendingRefreeze(s) {
  const last = Math.max(0, ...s.history.filter(e => e.kind === 'refreeze' || (['claim', 'renew'].includes(e.kind) && e.detail.adoptedCorrection != null)).map(e => e.id));
  const fields = new Set();
  for (const e of s.history.filter(e => e.kind === 'edit' && e.id > last).reverse()) {
    if (e.detail.correctedFrozen) break;
    for (const field of e.detail.pendingRefreeze ?? []) if (['after', 'criterion', 'check'].includes(field)) fields.add(field);
  }
  return [...fields].sort();
}

/** The builder's first-refusal window still open at `now`, read from the item's own history. */
export function firstRefusalWindow(s) {
  const kinds = ['reject', 'reopen', 'submit', 'release', 'reject_returned', 'submit_handoff_returned'];
  const releases = [];
  for (const e of s.history.filter(e => kinds.includes(e.kind)).reverse()) {
    if (e.kind === 'reject_returned' || e.kind === 'submit_handoff_returned') continue;
    if (e.kind === 'release' && !e.detail.reopenFirstRefusal?.otherSeatFirst && !e.detail.expiredClaim) { releases.push(e); continue; }
    if (e.kind === 'submit' || e.kind === 'reject') return null;
    const window = e.detail.reopenFirstRefusal;
    if (!window || !window.builder || !Number.isFinite(Date.parse(window.until))) return null;
    if (releases.some(r => r.by === window.builder && r.detail.review !== true)) return null;
    return Date.parse(s.now) < Date.parse(window.until) ? window : null;
  }
  return null;
}

/** Why the first-refusal window keeps this seat off, or null; an elapsed line takeover wait ends the window as it does for the writer. */
function firstRefusalReason(s, m) {
  const window = firstRefusalWindow(s);
  if (!window) return null;
  if (window.otherSeatFirst) {
    const reviewed = s.history.some(e => e.by === m.actor && ['accept', 'reject', 'reserve'].includes(e.kind));
    return reviewed ? `item #${m.id} returned for lack of progress; a reviewer of it cannot take the first refusal; take another item` : null;
  }
  return window.builder !== m.actor && !s.io.builderGone && !s.io.takeoverReady
    ? `item #${m.id} waits for ${window.builder} until ${window.until}; claim it after that time, or ask its builder to release it` : null;
}

/** The first unlanded dependency, or a claim_waiting wait still open. */
function dependencyProblem(s, m) {
  if (s.io.foreignBlocker) return `#${m.id} waits on ${s.io.foreignBlocker.label} (${s.io.foreignBlocker.status} on its own board); refresh that board before claiming`;
  for (const id of s.item.after) {
    const dep = s.items[id];
    if (dep.status !== 'verified' && dep.status !== 'withdrawn') {
      const shown = dep.status === 'claimed' && !leaseLive(s, dep) ? 'open' : dep.status;
      return `#${m.id} waits on #${id} (${shown}, ${dep.lane} lane); claim another item, or shout ${dep.lane} if it is stuck`;
    }
  }
  const open = s.claimWaiting.filter(id => s.items[id] && s.items[id].status !== 'withdrawn' && !s.items[id].merged);
  return open.length ? `#${m.id} is waiting on ${open.map(id => `#${id}`).join(', ')} to land; it returns to the queue when that lands` : null;
}

/** The ONE_CLAIM refusal message, or null: ten live claims at most, N top-level item-folder claims, one top-level claim without a folder. */
function oneClaimProblem(s, m) {
  if (isRenewal(s, m)) return null;
  const live = s.actorClaims.filter(c => c.id !== m.id && c.leaseUntil > s.now && !c.awaitingGateOrReview);
  if (live.length >= LIVE_CLAIM_CAP) return 'you already hold ten live claims; submit or release one before claiming another';
  const cap = seatCapFor(s, m);
  if (cap) {
    const top = live.filter(c => !freeChild(s, c.parentId) && !(c.verdict === 'REJECT' && c.builtBy === m.actor));
    if (top.length >= cap.n) return `you already hold ${top.map(c => `#${c.id}`).join(', ')}; a seat holds up to ${cap.n} (${cap.how}); submit or release one first (children of an item you hold are free)`;
  }
  if (m.itemFolder === true || freeChild(s, s.item.parentId) || isRework(s, m)) return null;
  const other = live.find(c => !freeChild(s, c.parentId) && !(c.verdict === 'REJECT' && c.builtBy === m.actor));
  return other ? `you already hold #${other.id}; submit or release it first (children of an item you hold are free)` : null;
}

/** A shell `cd` that quotes only paths that need it, as the CLI's does. */
const cdTo = (path) => `cd ${/^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replace(/'/gu, `'\\''`)}'`} &&`;

/** The lane refusal as the CLI words it: a free seat in the item's lane, or how to open one; plain words for coordinator items and higher routes. */
function wrongLane(s, m) {
  if (s.actor.lane === 'coordinator' || s.item.lane === 'coordinator' || routeIndex(s.item.route) > routeIndex(s.actor.route ?? 'strong')) {
    return { message: s.actor.lane === 'coordinator'
      ? `item #${m.id} is in the ${s.item.lane} lane, and lane items are built from that lane's worktree, never the main checkout. An agent runs: cd <its own worktree> && pullboard claim ${m.id}`
      : `item #${m.id} is in the ${s.item.lane} lane; you are in ${s.actor.lane}`, next: CLAIM_NEXT.WRONG_LANE };
  }
  const base = `item #${m.id} is in the ${s.item.lane} lane; this checkout is in ${s.actor.lane}`;
  if (s.io.laneSeat) return { message: `${base}. Build it in ${s.io.laneSeat.agent} at ${s.io.laneSeat.path}`, next: `${cdTo(s.io.laneSeat.path)} pullboard claim ${m.id}` };
  const open = `${s.io.primaryRoot ? `${cdTo(s.io.primaryRoot)} ` : ''}pullboard worktree ${s.item.lane} --model "${s.actor.model ?? '<model name>'}"`;
  return { message: `${base}. No seat was opened; open one in the ${s.item.lane} lane and claim it there`, next: `${open}, then in that worktree: pullboard claim ${m.id}` };
}

/** The seats module's unjoined refusal: it names this session's seats in other checkouts, with an always-quoted cd. */
function unjoined(s) {
  const join = 'pullboard join <lane> --model "<model name>"';
  const seats = s.io.sessionSeats ?? [];
  if (!seats.length) return { message: `this worktree has not joined a lane; run ${join}`, next: CLAIM_NEXT.NOT_JOINED };
  return { message: `this checkout has no seat, and your session's seats work in their own checkouts: ${seats.map(x => `${x.id} (${x.lane} lane) in ${x.path}`).join('; ')}`,
    next: `continue in that seat: cd '${seats[0].path.replaceAll("'", `'\\''`)}' && pullboard next; or give this checkout its own seat: ${join}` };
}

/** One rule and one guard per code a precomputed refusal can carry, so every guard keeps a fixed code. */
function coded(row, prefix, says, codes, problem) {
  const rules = {}, guards = [];
  for (const code of codes) {
    const name = `${prefix}${code}`;
    rules[name] = { says: `${says} (${code})`, holds: (s, m) => problem(s, m)?.code !== code };
    guards.push({ id: `${row}-${code.toLowerCase().replaceAll('_', '-')}`, requires: name, code, message: (s, m) => problem(s, m).message, next: help(code) });
  }
  return { rules, guards };
}

const bar = coded('bar-ready', 'barReady_', 'a required family is declared and a required bar is signed', DEFERRED_CODES.barProblem, (s) => s.deferred.barProblem);
const rework = coded('rework-routing', 'reworkRouted_', 'same-family rework waits for its builder or family', DEFERRED_CODES.reworkRouting, (s) => s.deferred.reworkRouting?.refused);
const frozen = coded('rows-in-force', 'rowsInForce_', 'where the criterion freezes, its rows are in force', FREEZE_CODES, (s, m) => (freezes(s, m) ? s.io.freeze?.refused : null));

/** The claim facts, each one named rule. Snapshot and move shapes are listed on `claimEngine`. */
const CLAIM_RULES = defineRules({
  checkoutMine: { says: 'a checkout bound to another agent session is not used by this one', holds: (s) => !s.io.checkoutOwner },
  noCoordinatorPath: { says: 'a lane builds no bar that names a path no lane owns',
    holds: (s, m) => !(s.item && m.actor !== 'coordinator' && s.item.lane !== 'coordinator' && s.io.coordinatorPaths.length > 0) },
  checkProvesSomething: { says: 'a check already green on main proves nothing', holds: (s) => !(s.item && ['open', 'claimed'].includes(s.item.status) && s.io.provesNothing) },
  policyContainsFrozen: { says: 'accepted main still contains the frozen policy and its lane and gate keys did not change', holds: (s) => !s.io.policyRefresh?.refused },
  reworkWindows: { says: 'returned rework needs the accepted takeover and maintenance windows', holds: (s) => !(s.item?.returnedRework === true && !s.io.reworkWindows) },
  exitCeiling: { says: 'with exit rules on, a fresh claim needs context left under the ceiling', holds: (s, m) => !(s.io.exitCeiling && !(s.item.status === 'claimed' && s.item.owner === m.actor)) },
  sessionLedger: { says: 'the session ledger is writable before a claim', holds: (s) => s.io.ledgerWritable !== false },
  joined: { says: "the caller is a joined seat; the refusal names this session's seats elsewhere", holds: (s) => Boolean(s.actor.joined) },
  itemExists: { says: 'the item exists', holds: (s) => Boolean(s.item) },
  inState: { says: 'only an open or claimed item is claimed', holds: (s) => ['open', 'claimed'].includes(s.item.status) },
  ...bar.rules,
  itemNotHeld: { says: 'a coordinator-held item takes no new claim', holds: (s, m) => !(s.item.holdReason && !isRenewal(s, m)) },
  insideSource: { says: 'an outside PR item stays with its author', holds: (s) => s.item.outside !== 'pull-request' },
  inLane: { says: 'an item is built from its own lane; the refusal names where to build it', holds: (s) => s.item.lane === s.actor.lane },
  lightDiagnosed: { says: 'light work by a light seat needs a current diagnosis', holds: (s, m) => !(seatRoute(s, m) === 'light' && s.item.route === 'light' && !s.item.diagnosed) },
  abilitiesCoverNeeds: { says: 'an item is claimed only by a seat whose abilities cover its needs; an absent needs list or abilities list reads as empty', holds: (s) => missingNeeds(s.item.needs, s.actor.abilities).length === 0 },
  routeAllows: { says: 'a seat takes work at or below its route', holds: (s, m) => routeIndex(seatRoute(s, m)) >= routeIndex(s.item.route) || m.shapedStrong === true && seatRoute(s, m) === 'light' && s.item.route === 'strong' },
  budgetValid: { says: 'the board build budget is positive minutes',
    holds: (s, m) => isRenewal(s, m) || (typeof s.io.buildBudgetMinutes === 'number' && Number.isFinite(s.io.buildBudgetMinutes) && s.io.buildBudgetMinutes > 0) },
  buildScope: { says: 'a new claim fits the board build budget', holds: (s, m) => isRenewal(s, m) || s.item.expectedMinutes == null || s.item.expectedMinutes <= s.io.buildBudgetMinutes },
  dependencies: { says: 'every dependency is verified or withdrawn, and a blocked release waits for its landing', holds: (s, m) => dependencyProblem(s, m) === null },
  notHeldByAnother: { says: 'a live claim belongs to its holder', holds: (s, m) => !(leaseLive(s, s.item) && s.item.owner !== m.actor) },
  exitContinuation: { says: 'an exit hand-off continues in its reserved family', holds: (s) => !s.deferred.exitContinuation },
  ...rework.rules,
  firstRefusal: { says: 'returned work waits for its builder until the window ends', holds: (s, m) => Boolean(s.deferred.reworkRouting?.applies) || firstRefusalReason(s, m) === null },
  correctionRefrozen: { says: 'a pending coordinator correction is refrozen or adopted first', holds: (s, m) => adopts(s, m) || pendingRefreeze(s).length === 0 },
  laneOpen: { says: 'a held lane takes no new claims', holds: (s, m) => !(s.laneHold && !isRenewal(s, m)) },
  lineCapacity: { says: 'a new claim fits the line WIP limit', holds: (s) => !s.deferred.lineCapacity },
  oneLiveClaim: { says: 'ten live claims at most, N top-level item-folder claims, one top-level claim without an item folder', holds: (s, m) => oneClaimProblem(s, m) === null },
  ...frozen.rules,
  exitKey: { says: 'an enabled exit policy carries a fresh native claim key',
    holds: (s, m) => !m.exitRules || (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(m.exitClaimKey ?? '') && (isRenewal(s, m) || !s.usedExitKeys.includes(m.exitClaimKey))) },
  renewing: { says: 'the caller already holds a live claim on the item, so this is a renewal', holds: (s, m) => isRenewal(s, m) },
  policyNamed: { says: 'a fresh claim re-froze the lane policy and the freeze named what changed',
    holds: (s, m) => !isRenewal(s.before, m) && refreshes(s.before, m) && freezes(s.before, m) && Array.isArray(s.before.io.policyRefresh?.changed) },
  exitAnchored: { says: 'a fresh claim under exit rules spends its key', holds: (s, m) => !isRenewal(s.before, m) && Boolean(m.exitRules) },
});

/** The item fields a claim writes. */
function patchOf(s, m, renewed) {
  const freeze = freezes(s, m) ? s.io.freeze : null;
  return { status: 'claimed', owner: m.actor, leaseUntil: new Date(Date.parse(s.now) + m.leaseMs).toISOString(),
    ...(freeze ? { frozen: freeze.text, frozenDigest: freeze.digest } : {}), ...(!renewed && s.io.head ? { claimHead: s.io.head } : {}) };
}

/** The claim or renew event detail, key for key as the board writes it today. */
function detailOf(s, m, renewed, grantEngine) {
  const freeze = freezes(s, m) ? s.io.freeze : null;
  const digest = freeze ? freeze.digest : s.item.frozenDigest;
  const snap = s.io.autoNextSnapshot;
  const cap = seatCapFor(s, m);
  return {
    leaseUntil: new Date(Date.parse(s.now) + m.leaseMs).toISOString(), digest,
    ...(!renewed && m.autoNext === true && snap?.head === s.io.head && /^[0-9a-f]{64}$/u.test(snap?.digest ?? '') ? { autoNextSnapshot: snap } : {}),
    ...(!renewed && m.itemFolder === true ? { itemFolder: true } : {}),
    ...(cap ? { claimsPerSeat: cap.n } : {}),
    ...(!renewed && m.exitRules ? { exitRules: m.exitRules, exitClaimKey: m.exitClaimKey } : {}),
    ...(adopts(s, m) ? { adoptedCorrection: digest } : {}),
    ...(refreshes(s, m) && freeze ? { policyRefreshed: digest } : {}),
    ...(!renewed && m.reviewSkipped ? { reviewSkipped: m.reviewSkipped } : {}),
    ...(!renewed && s.item.expectedMinutes != null ? { buildBudgetMinutes: s.io.buildBudgetMinutes, expectedBuildMinutes: s.item.expectedMinutes } : {}),
    ...(s.deferred.submitAdmission ? { submitAdmission: s.deferred.submitAdmission } : {}),
    ...(s.deferred.submitOutcome ? { submitOutcome: s.deferred.submitOutcome } : {}),
    grantEngine,
  };
}

/** The claim table: guards in the order today's CLI and board throw, then renew or claim, then the two automatic follow-ups. */
function claimTable(grantEngine) {
  const guard = (id, requires, code, message, next = help(code)) => ({ id, requires, code, message, next });
  return Object.freeze({
    name: 'claim',
    guards: Object.freeze([
      // CLI preconditions, in the order the command runs them before the ordered move.
      guard('checkout-is-mine', 'checkoutMine', 'NOT_YOUR_CHECKOUT', (s) => `this checkout belongs to ${s.io.checkoutOwner} in another agent session`, 'continue in your own checkout: pullboard next'),
      guard('no-coordinator-path', 'noCoordinatorPath', 'CROSS_OWNERSHIP', (s) => `the bar names ${s.io.coordinatorPaths.join(', ')}, which no lane owns, so lane ${s.item.lane} cannot build it`, (s) => s.io.coordinatorPathsNext),
      guard('check-proves-something', 'checkProvesSomething', 'CRITERION_PROVES_NOTHING', (s) => s.io.provesNothing?.message),
      guard('policy-contains-frozen', 'policyContainsFrozen', 'NO_POLICY', (s) => s.io.policyRefresh.refused),
      guard('rework-windows', 'reworkWindows', 'NO_POLICY', 'the accepted coordinator takeover and maintenance windows are unavailable; restore the current main policy before claiming returned work'),
      guard('exit-ceiling', 'exitCeiling', 'EXIT_CEILING', (s) => s.io.exitCeiling?.message),
      guard('session-ledger', 'sessionLedger', 'SESSION_LEDGER', 'the agent-session ledger is not writable'),
      // The board's declared guards, in order.
      guard('joined', 'joined', 'NOT_JOINED', (s) => unjoined(s).message, (s) => unjoined(s).next),
      guard('item-exists', 'itemExists', 'NO_ITEM', (s, m) => `no item #${m.id}; see: pullboard list`),
      guard('in-state', 'inState', 'NOT_CLAIMABLE', (s, m) => `item #${m.id} is ${s.item.status}`),
      ...bar.guards,
      guard('item-not-held', 'itemNotHeld', 'ITEM_HELD', (s, m) => `item #${m.id} is held by coordinator: ${s.item.holdReason}; take another eligible item with pullboard next, or end your turn if none is offered`),
      guard('outside-source', 'insideSource', 'OUTSIDE_NATIVE_BUILD', (s, m) => `outside item #${m.id} stays with its PR author; ask the coordinator to return it, then intake the author's new exact head`),
      guard('in-lane', 'inLane', 'WRONG_LANE', (s, m) => wrongLane(s, m).message, (s, m) => wrongLane(s, m).next),
      guard('light-diagnosed', 'lightDiagnosed', 'DIAGNOSIS_REQUIRED', (s, m) => `#${m.id} has no current diagnosis; keep it mid or strong, then have a capable seat record Files, Change and Test case with pullboard fact <id> diagnosis`),
      guard('abilities-cover-needs', 'abilitiesCoverNeeds', 'NEEDS_ABILITY', (s, m) => `item #${m.id} needs ${missingNeeds(s.item.needs, s.actor.abilities).join(' and ')}, which this seat's abilities lack`),
      guard('route-allows', 'routeAllows', 'ROUTE', (s, m) => `item #${m.id} needs a ${s.item.route} model; ${seatRoute(s, m) === (s.actor.route ?? 'strong') ? 'you joined on' : 'the model this session declared serves'} the ${seatRoute(s, m)} route. Take your next item: pullboard next`),
      guard('budget-valid', 'budgetValid', 'BAD_BUILD_BUDGET', 'restore a positive itemBuildBudgetMinutes setting, then retry'),
      guard('build-scope', 'buildScope', 'ITEM_BUILD_BUDGET', (s, m) => `item #${m.id} expects ${s.item.expectedMinutes} build minutes, above the ${s.io.buildBudgetMinutes}-minute board budget`,
        (s, m) => `cut #${m.id} into a parent and children with --expected-minutes at or below ${s.io.buildBudgetMinutes}; claim a child instead`),
      guard('dependencies', 'dependencies', 'BLOCKED', (s, m) => dependencyProblem(s, m)),
      guard('not-held-by-another', 'notHeldByAnother', 'HELD', (s, m) => `item #${m.id} is held by ${s.item.owner} until ${s.item.leaseUntil}`),
      guard('exit-continuation', 'exitContinuation', 'EXIT_CONTINUATION', (s) => s.deferred.exitContinuation?.message),
      ...rework.guards,
      guard('first-refusal', 'firstRefusal', 'REOPEN_HELD_FOR_BUILDER', (s, m) => firstRefusalReason(s, m)),
      guard('correction-refrozen', 'correctionRefrozen', 'PENDING_REFREEZE', (s, m) => `item #${m.id} has a pending ${pendingRefreeze(s).join(' and ')} correction; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${m.id}`),
      guard('lane-open', 'laneOpen', 'LANE_HELD', (s) => `${s.laneHold.by} holds the ${s.item.lane} lane: ${s.laneHold.reason}; take other available work with pullboard next, or end your turn if none is offered`),
      guard('line-capacity', 'lineCapacity', 'LINE_WIP_LIMIT', (s) => s.deferred.lineCapacity?.message),
      guard('one-live-claim', 'oneLiveClaim', 'ONE_CLAIM', (s, m) => oneClaimProblem(s, m)),
      ...frozen.guards,
      // Inside the write.
      guard('exit-key', 'exitKey', 'EXIT_USAGE', 'a native claim key is single-use; preserve the prior claim and capture a fresh key'),
    ]),
    outcomes: Object.freeze([
      { id: 'renew', when: 'renewing', patch: (s, m) => patchOf(s, m, true), events: (s, m) => [{ kind: 'renew', by: m.actor, detail: detailOf(s, m, true, grantEngine) }] },
      { id: 'claim', patch: (s, m) => patchOf(s, m, false), events: (s, m) => [{ kind: 'claim', by: m.actor, detail: detailOf(s, m, false, grantEngine) }] },
    ]),
    followups: Object.freeze([
      { id: 'policy-refrozen-fact', when: 'policyNamed',
        apply: ({ before: s, move: m }) => {
          const p = s.io.policyRefresh;
          return { patch: {}, events: [{ kind: 'fact', by: m.actor, detail: { id: m.factId, kind: 'note', text: `policy re-frozen automatically: ${p.before} -> ${p.after}; only ${p.changed.join(', ')} changed`, ref: null, supersedes: null } }] };
        } },
      { id: 'exit-anchor', when: 'exitAnchored',
        apply: ({ move: m }) => ({ patch: { meta: { [`exit-claim-key:${m.exitClaimKey}`]: { item: m.id, agent: m.actor }, [`exit-handoff:${m.id}`]: null } }, events: [] }) },
    ]),
  });
}

/**
 * Build the claim rules and table over the grant engine the board stamps on every claim, handed in by the caller.
 * Snapshot: `{ now, actor: { id, lane, route, model, joined }, item, items, claimWaiting, laneHold, actorClaims, history, usedExitKeys, io, deferred }`;
 * `io` holds the fields in CLAIM_IO, `deferred` the precomputed `barProblem`, `reworkRouting`, `exitContinuation`, `lineCapacity`, `submitAdmission` and `submitOutcome`.
 * Move: `{ id, actor, leaseMs, itemFolder, autoNext, reviewSkipped, adoptCorrection, routeCap, shapedStrong, exitRules, exitClaimKey, factId }`.
 * Why: moves may not own the engine version; the caller passes state's `AGENT_GRANT_ENGINE`, so there is no second copy to drift (as hop.table.js takes the jobs lease rule).
 *
 * @param {{ grantEngine: number }} board
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function claimEngine(board) {
  if (!Number.isSafeInteger(board?.grantEngine) || board.grantEngine < 1) {
    throw new Refused('CLAIM_TABLE_INPUTS', 'the claim table needs the grant engine every claim stamps', "pass AGENT_GRANT_ENGINE from state's front door");
  }
  return Object.freeze({ rules: CLAIM_RULES, table: claimTable(board.grantEngine) });
}
