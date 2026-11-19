import { defineRules } from '../table/rules.js';
import { deriveFact } from '../table/rules.js';

/**
 * The item lifecycle as rules over recorded facts: states, move rows, named guards and derived readiness [C7].
 * Why: U152 puts "what is true" (ready, blocked, held, who may move it) in one place that both a trial replay and the
 * U146 move tables can read, so no table defines readiness its own way. Pure: no clock, no git, no SQLite.
 */

/** Bump when a rule row or guard changes, so a stored report names the rules it ran. */
export const RULES_VERSION = 1;

/** The five states an item is ever in. */
export const STATES = ['open', 'claimed', 'submitted', 'verified', 'withdrawn'];

/** The fact flag that marks a release as the board's own maintenance, which any seat may write for a dead claim. */
const MAINTENANCE = 'maintenance';

/**
 * The state an item starts in, and a record of it.
 *
 * @param {number} id
 * @param {number[]} after - Items it waits on.
 * @returns {object} A fresh item fact set.
 */
export function newItem(id, after = []) {
  return { id, created: true, status: 'open', owner: null, leaseUntil: null, builder: null, held: false, merged: false, after: [...after], lastEvent: null };
}

/**
 * Is the item's lease still running at a moment?
 *
 * @param {{ leaseUntil: string | null }} item
 * @param {string} at - ISO time.
 * @returns {boolean}
 */
export function leaseLive(item, at) {
  if (!item.leaseUntil) return false;
  const until = Date.parse(item.leaseUntil);
  return Number.isFinite(until) && Date.parse(at) < until;
}

/**
 * What each item this one waits on is, by the rule "every item it waits on is verified".
 * An id the item also lists in `afterGate` is met as soon as that item is submitted with `gateGreen` true; absent fields keep the plain rule.
 *
 * @param {{ after: number[], afterGate?: number[] }} item
 * @param {Map<number, object>} items
 * @returns {{ id: number, state: string }[]} The waits that are not yet verified, each with what it is instead.
 */
export function unmetWaits(item, items) {
  const unmet = [];
  for (const id of item.after) {
    const dep = items.get(id);
    if (dep?.status === 'verified') continue;
    if (dep?.status === 'submitted' && dep.gateGreen === true && item.afterGate?.includes(id)) continue;
    unmet.push({ id, state: !dep ? 'missing' : dep.status === 'withdrawn' ? (dep.merged ? 'withdrawn-landed' : 'withdrawn') : dep.status });
  }
  return unmet;
}

/** The moves a builder may make on its own submitted item when every row is low-stakes and every check is machine-run: reserve and accept, never reject or a post-landing review. */
const SELF_VERIFY_KINDS = Object.freeze(['reserve', 'accept', 'merge-only-accept']);

/**
 * The rows the item froze at its claim, as `{ id, stakes? }`, read from the item in the move snapshot (`item.frozen`, the frozen
 * record as text or as parsed). A row with no stakes field froze as team (#11412). Null when the item carries no record.
 *
 * @param {{ frozen?: string | { rows?: { id?: string, stakes?: string }[] } } | undefined} item
 * @returns {{ id?: string, stakes?: string }[] | null}
 */
function frozenRowsOf(item) {
  let record = item?.frozen;
  if (typeof record === 'string') {
    try { record = JSON.parse(record); } catch { return null; }
  }
  return Array.isArray(record?.rows) ? record.rows : null;
}

/**
 * Does every row the caller's snapshot carries match the item's frozen record? Each snapshot row must name a frozen row by id and
 * state the stakes it froze with, and every frozen row must appear. Why: the board record, never the snapshot a caller builds, decides
 * the stakes, so a forged low row cannot lift a team or critical row into a self-accept (#1084). No frozen record means no match.
 *
 * @param {{ item?: object, rows?: { id?: string, stakes?: string }[] }} snapshot
 * @returns {boolean}
 */
function rowsMatchFrozen(snapshot) {
  const frozen = frozenRowsOf(snapshot?.item);
  const { rows } = snapshot ?? {};
  if (!frozen || !Array.isArray(rows)) return false;
  const stakesById = new Map(frozen.map(row => [row?.id, row?.stakes ?? 'team']));
  const seen = new Set();
  for (const row of rows) {
    if (!stakesById.has(row?.id) || stakesById.get(row.id) !== (row.stakes ?? 'team')) return false;
    seen.add(row.id);
  }
  return seen.size === stakesById.size;
}

/** Does the snapshot claim every row low-stakes and person-approved and every check machine-run red then green? */
function claimsSoloLowStakes(snapshot, kind) {
  if (snapshot?.soloLowStakes !== true || !SELF_VERIFY_KINDS.includes(kind)) return false;
  const { rows, checks } = snapshot;
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => row?.stakes === 'low' && row.personApproved === true)
    && Array.isArray(checks) && checks.length > 0 && checks.every(check => check?.machineRun === true && check.redBefore === true && check.greenAfter === true);
}

/**
 * May the builder make this move on its own work? Only when the snapshot carries `soloLowStakes: true` (the verify.soloLowStakes
 * setting, default off), `rows` where every row is `{ id, stakes: 'low', personApproved: true }` and equals what the item froze, and `checks` where every check is
 * `{ machineRun: true, redBefore: true, greenAfter: true }`. Why: #966, a low-stakes row whose checks a machine ran red then green needs no second agent;
 * absent fields, empty lists and any other value keep the independence rule, so a board with no stakes field is unchanged. The verify command fills the fields (#11141).
 * The stakes come from the item's frozen record, so a snapshot that says low for a row frozen at team or critical never self-accepts (#11415).
 *
 * @param {{ item?: object, soloLowStakes?: boolean, rows?: { id?: string, stakes?: string, personApproved?: boolean }[], checks?: { machineRun?: boolean, redBefore?: boolean, greenAfter?: boolean }[] }} snapshot
 * @param {string | undefined} kind - The move kind or name.
 * @returns {boolean}
 */
export function soloLowStakesHolds(snapshot, kind) {
  return claimsSoloLowStakes(snapshot, kind) && rowsMatchFrozen(snapshot);
}

/**
 * Did the snapshot claim a solo self-accept that the item's frozen record contradicts? True exactly when every other solo condition
 * holds and only the rows disagree with the frozen record: the forgery LOW_STAKES_FORGED names.
 *
 * @param {object} snapshot
 * @param {string | undefined} kind
 * @returns {boolean}
 */
export function soloLowStakesForged(snapshot, kind) {
  return claimsSoloLowStakes(snapshot, kind) && !rowsMatchFrozen(snapshot);
}

/**
 * The named rules, as data on the move tables' derived-facts layer (#8063): each has `says`, the facts it
 * `reads`, and a pure `holds(snapshot, move, fact)` that returns a boolean. The snapshot is `{ item, items }` and the move is the recorded fact.
 * Why defineRules: one rules engine, so a bad rule is refused when written and every answer is traced.
 */
export const RULES = defineRules({
  itemExists: { says: 'an add event came before this move', holds: ({ item }) => item.created !== false },
  isOpen: { says: 'the item is open, waiting for a builder', holds: ({ item }) => item.status === 'open' },
  notHeld: { says: 'the coordinator has not put the item on hold', holds: ({ item }) => !item.held },
  dependenciesVerified: { says: 'every item it waits on is verified', holds: ({ item, items }) => !unmetWaits(item, items).length },
  ready: { says: 'open, not held, and waiting on nothing unverified', reads: ['isOpen', 'notHeld', 'dependenciesVerified'],
    holds: (snapshot, move, fact) => fact('isOpen') && fact('notHeld') && fact('dependenciesVerified') },
  blocked: { says: 'open and waiting on something unverified', reads: ['isOpen', 'dependenciesVerified'],
    holds: (snapshot, move, fact) => fact('isOpen') && !fact('dependenciesVerified') },
  notHeldByAnother: { says: 'no other agent holds it under a live lease', holds: ({ item }, move) => !(item.status === 'claimed' && item.owner !== move.by && leaseLive(item, move.at)) },
  isHolder: { says: 'the caller holds the claim', holds: ({ item }, move) => item.owner === move.by },
  holderOrCoordinator: { says: 'the holder, the coordinator or a maintenance sweep makes the move', holds: ({ item }, move) => move.by === 'coordinator' || item.owner === move.by || Boolean(move[MAINTENANCE]) },
  notBuilder: { says: 'the caller did not build the item', holds: (snapshot, move) => !(snapshot.item.builder && snapshot.item.builder === move.by) || soloLowStakesHolds(snapshot, move.kind) },
  coordinatorOnly: { says: 'the caller is the coordinator', holds: (snapshot, move) => move.by === 'coordinator' },
  notMerged: { says: 'the item has no recorded merge receipt', holds: ({ item }) => !item.merged },
  verifiedToLand: { says: 'only a verified item lands', holds: ({ item }) => item.status === 'verified' },
});

/**
 * The refusal each rule would have been when it does not hold: the board's code and why, so a disagreement reads like a refusal.
 *
 * @type {Record<string, (snapshot: { item: object, items: Map<number, object> }, move: object) => { code: string, why: string }>}
 */
const REFUSALS = {
  itemExists: () => ({ code: 'NO_ITEM', why: 'no add event came before this move' }),
  notHeld: () => ({ code: 'ITEM_HELD', why: 'the coordinator held it and had not lifted the hold' }),
  dependenciesVerified: ({ item, items }) => { const [first] = unmetWaits(item, items); return { code: `BLOCKED (waits on a ${first.state} item)`, why: `#${first.id} is ${first.state}` }; },
  notHeldByAnother: ({ item }) => ({ code: 'HELD', why: `${item.owner} held it under a live lease until ${item.leaseUntil}` }),
  isHolder: ({ item }, move) => ({ code: 'NOT_YOURS', why: `${item.owner ?? 'nobody'} held it, not ${move.by}` }),
  holderOrCoordinator: ({ item }, move) => ({ code: 'NOT_YOURS', why: `${item.owner ?? 'nobody'} held it, not ${move.by}` }),
  notBuilder: (snapshot, move) => soloLowStakesForged(snapshot, move.kind)
    ? { code: 'LOW_STAKES_FORGED', why: `${move.by} sent low-stakes rows that the item's frozen record does not hold` }
    : { code: 'SELF_VERIFY', why: `${move.by} built it` },
  coordinatorOnly: (snapshot, move) => ({ code: 'COORDINATOR_ONLY', why: `${move.by} is not the coordinator` }),
  notMerged: () => ({ code: 'ALREADY_MERGED', why: 'a merge receipt was already recorded' }),
  verifiedToLand: ({ item }, move) => ({ code: `NOT_VERIFIED (${move.forced ? 'forced ' : ''}from ${move.from ?? item.status})`, why: `the item was ${item.status} in the replay when it landed` }),
};

/** Derive one named fact over a snapshot and move on the shared rules layer. */
const derive = (name, snapshot, move) => deriveFact(RULES, name, snapshot, move).holds;

/**
 * Derived readiness: the one definition of ready and blocked, derived from named rules.
 *
 * @param {object} item
 * @param {Map<number, object>} items
 * @returns {{ ready: boolean, blocked: boolean, held: boolean, unmet: { id: number, state: string }[] }}
 */
export function readiness(item, items) {
  const snapshot = { item, items };
  return { ready: derive('ready', snapshot, {}), blocked: derive('blocked', snapshot, {}), held: item.held, unmet: item.status === 'open' ? unmetWaits(item, items) : [] };
}

/**
 * The move rows. `from` lists the states a move may start in; `to` is where it ends (null keeps the state).
 * `guards` are checked in order after the state, and the first that fails names the disagreement.
 *
 * @type {{ id: string, from: string[], to: string | null, guards: string[], says: string }[]}
 */
export const MOVE_RULES = [
  { id: 'claim', from: ['open', 'claimed'], to: 'claimed', guards: ['notHeldByAnother', 'notHeld', 'dependenciesVerified'], says: 'an open item that is not held and waits on nothing unverified can be claimed; a live lease is not taken from its holder' },
  { id: 'renew', from: ['claimed'], to: 'claimed', guards: ['isHolder'], says: 'only the holder renews a claim' },
  { id: 'release', from: ['open', 'claimed'], to: 'open', guards: ['holderOrCoordinator'], says: 'the holder, the coordinator or a maintenance sweep returns a claim to the queue' },
  { id: 'release-review', from: ['submitted'], to: null, guards: [], says: 'a review reservation is freed and the item stays submitted' },
  { id: 'submit', from: ['claimed'], to: 'submitted', guards: ['isHolder'], says: 'the holder submits a claimed item' },
  { id: 'reserve', from: ['submitted'], to: null, guards: ['notBuilder'], says: 'a reviewer other than the builder reserves a submitted item' },
  { id: 'accept', from: ['submitted', 'verified'], to: 'verified', guards: ['notBuilder'], says: 'a verifier other than the builder accepts a submitted item' },
  { id: 'reject', from: ['submitted', 'verified'], to: 'open', guards: ['notBuilder'], says: 'a verifier other than the builder rejects a submitted item, which reopens it' },
  { id: 'reopen', from: ['submitted', 'verified'], to: 'open', guards: ['notMerged'], says: 'a submitted or verified item that is not yet merged reopens' },
  { id: 'merged', from: STATES, to: null, guards: ['verifiedToLand'], says: 'only a verified item lands' },
  { id: 'review-landed', from: ['verified', 'withdrawn'], to: null, guards: ['notBuilder'], says: 'a post-landing review follows a landing' },
  { id: 'withdraw', from: ['open', 'claimed', 'submitted', 'verified'], to: 'withdrawn', guards: ['coordinatorOnly'], says: 'the coordinator withdraws any item that is not already withdrawn' },
  { id: 'hold', from: STATES, to: null, guards: [], says: 'an item may be held in any state' },
  { id: 'unhold', from: STATES, to: null, guards: [], says: 'a hold may be lifted in any state' },
  { id: 'refreeze', from: ['open', 'claimed', 'submitted', 'verified'], to: null, guards: [], says: 'a correction refreezes a bar and keeps the state' },
  { id: 'edit-after', from: STATES, to: null, guards: [], says: 'the coordinator changes what an item waits on' },
  { id: 'intake', from: ['open'], to: 'submitted', guards: [], says: 'an outside commit enters as submitted' },
];

/**
 * Pick the move rule a recorded fact is an instance of.
 *
 * @param {{ kind: string, review?: boolean, landed?: boolean }} fact
 * @returns {string | null} A MOVE_RULES id, or null when no rule describes this kind of move.
 */
export function ruleOf(fact) {
  switch (fact.kind) {
    case 'claim': return 'claim';
    case 'renew': return 'renew';
    case 'release': return fact.review ? 'release-review' : 'release';
    case 'submit': return 'submit';
    case 'reserve': return 'reserve';
    case 'accept': case 'merge-only-accept': return 'accept';
    case 'verify': return 'review-landed';
    case 'reject': return 'reject';
    case 'reopen': return 'reopen';
    case 'merged': return 'merged';
    case 'withdraw': return 'withdraw';
    case 'hold_item': return 'hold';
    case 'unhold_item': return 'unhold';
    case 'refreeze': return 'refreeze';
    case 'edit': return 'edit-after';
    case 'intake': case 'outside-intake': return 'intake';
    default: return null;
  }
}

/**
 * Judge one fact against the rules, given the item as it stood just before. Pure; applies nothing.
 *
 * @param {object} item - The item before the move.
 * @param {object} fact - A normalized lifecycle fact.
 * @param {Map<number, object>} items - Every item, as it stood before.
 * @param {object} [snapshotFields] - Fields the caller's snapshot adds for a guard to read (`soloLowStakes`, `rows`, `checks`).
 * @returns {{ rule: string | null, ok: boolean, code?: string, why?: string }}
 */
export function judge(item, fact, items, snapshotFields = {}) {
  const rule = ruleOf(fact);
  if (!rule) return { rule: null, ok: false, code: 'NO_RULE', why: `no rule describes a ${fact.kind} move` };
  const row = MOVE_RULES.find(entry => entry.id === rule);
  const snapshot = { ...snapshotFields, item, items };
  if (!derive('itemExists', snapshot, fact)) return { rule, ok: false, ...REFUSALS.itemExists(snapshot, fact) };
  if (!row.from.includes(item.status)) return { rule, ok: false, code: `WRONG_STATE (from ${item.status})`, why: `a ${fact.kind} cannot start from ${item.status}` };
  for (const name of row.guards) {
    if (!derive(name, snapshot, fact)) return { rule, ok: false, ...REFUSALS[name](snapshot, fact) };
  }
  return { rule, ok: true };
}

/**
 * Apply what a recorded move did to the item's facts. The board did the move, so this follows it even when the rules refused it.
 *
 * @param {object} item
 * @param {object} fact
 * @param {string | null} rule - The rule id from judge().
 * @returns {object} The item after, as a new object.
 */
export function apply(item, fact, rule) {
  const next = { ...item, lastEvent: fact.id };
  const row = MOVE_RULES.find(entry => entry.id === rule);
  if (row?.to) next.status = row.to;
  if (rule === 'claim' || rule === 'renew') { next.owner = fact.by; next.leaseUntil = fact.leaseUntil ?? item.leaseUntil; }
  if (['release', 'reject', 'reopen', 'withdraw'].includes(rule)) { next.owner = null; next.leaseUntil = null; }
  if (rule === 'submit' || rule === 'intake') { next.builder = fact.by; next.owner = null; next.leaseUntil = null; }
  if (rule === 'merged') next.merged = true;
  if (rule === 'hold') next.held = true;
  if (rule === 'unhold') next.held = false;
  if (rule === 'edit-after' && Array.isArray(fact.after)) next.after = [...fact.after];
  if (rule === 'release' && Array.isArray(fact.blockedOn)) next.after = [...new Set([...item.after, ...fact.blockedOn])];
  return next;
}
