/** The backbone table: every item move and every job kind with the item state it serves, one source [C7,#8067]. */
import { MACHINE } from '../../../../state/light.js';
import { APPLIED_RULES } from './item-moves.js';
import { GUARD_RULES } from './item-moves.js';
import { ITEM_GUARDS } from './item-moves.js';
import { ITEM_OUTCOMES } from './item-moves.js';
import { KNOWN_RULES } from './item-moves.js';
import { LANDINGS } from './rules.js';
import { landingOf } from './rules.js';
import { defineRules } from './rules.js';

/**
 * The job kinds and what each serves, in words. Why: U145 rule 1 says nothing exists outside the map, so this list is the source
 * and the machines.json fixture is compared to it. Each kind has a `serves.<kind>` rule in BACKBONE_RULES that says it in code.
 */
export const JOB_KINDS = Object.freeze([
  { kind: 'gate', serves: "item claimed by the hand-off's seat at its commit and frozen digest, until the gate's green turns into the submit" },
  { kind: 'review', serves: 'item submitted at the reserved commit and digest, reserved by this reviewer' },
  { kind: 'landing-run', serves: 'the verified, unmerged items of one landing pass' },
  { kind: 'landing', serves: "the batch's verified items at their recorded commits" },
  { kind: 'main-test', serves: "no item: main's tree and one test file" },
  { kind: 'gate-verdict', serves: "item submitted at the candidate, waiting on main's own test result" },
  { kind: 'flake-diagnose', serves: "a finished gate's verdict" },
  { kind: 'cells-inventory', serves: 'no item: a tree id' },
  { kind: 'test-run', serves: 'no item that it ends: the seat that queued it, and an optional item for display' },
  { kind: 'land', serves: "the landing's accepted items at the trunk sha they were accepted against; the runner re-checks each and the board applies the receipt" },
  { kind: 'gate-shard', serves: 'item submitted at the candidate, one slice of its proof files; the gate result applies when the last shard posts' },
  { kind: 'test', serves: 'no item that it ends: the seat waiting on pullboard test; the board records the receipt and applies nothing' },
  { kind: 'check-baseline', serves: "item whose frozen check is measured at main; the receipt is recorded on the item's pending baseline" },
  // Created by runScreenJob in the drive cell, for sprint items only [#8867].
  { kind: 'screen', serves: "a submitted sprint item at its commit on the current base: the merge, static checks on its changed files, and secrets and hook rules re-checked by trusted code" },
  // Created by runPullOutJob in the landing cell, for sprint items only: only a sprint item reaches landing pulling [#8870,#9099].
  { kind: 'pull-out', serves: "an item whose landing is pulling: the lander reverts its landed commit on main and records pulled" },
]);

/** The job kinds some code creates today, the ones the state map lists; a kind declared with `created: false` waits for its runner. */
export const CREATED_JOB_KINDS = Object.freeze(JOB_KINDS.filter(job => job.created !== false).map(job => job.kind));

/**
 * Whether a job receipt counts for an item: green, from trusted code under a live lease, at the item's commit and frozen digest, and for a screen or a suite on the current base.
 * A 'suite' receipt must also be a full-suite run (`suite: 'full'`) for the item's own group (its lane), so a partial suite or another group's run never counts [#9324].
 * Why one predicate: the landing rows that demand a receipt (screened, and the Always rows after it) read it here, so no row restates what a receipt must prove.
 *
 * @param {{ kind?: string, green?: boolean, trusted?: boolean, leased?: boolean, commit?: string, digest?: string, base?: string, suite?: string, group?: string } | null | undefined} receipt
 * @param {{ kind: string, item: { commit?: string | null, digest?: string | null, group?: string | null }, base?: string | null }} at - The kind wanted, the item as it stands, and the current base.
 * @returns {boolean}
 */
export function receiptCounts(receipt, { kind, item, base }) {
  if (!receipt || receipt.kind !== kind || receipt.green !== true || receipt.trusted !== true || receipt.leased !== true) return false;
  if (!item?.commit || receipt.commit !== item.commit || receipt.digest !== item.digest) return false;
  if (kind === 'suite' && (receipt.suite !== 'full' || !item.group || receipt.group !== item.group)) return false;
  return (kind !== 'screen' && kind !== 'suite') || (Boolean(base) && receipt.base === base);
}

/**
 * The legal (status, landing) pairs, declared once; every other pair is unreachable.
 * Why: a landed item that is not yet verified (Sprint) and a pull-out need the pair, not a merged flag on verified work.
 * withdrawn with landed is today's forced hand landing of unfinished work; pulling and published have no writer yet.
 */
export const LEGAL_LANDING = Object.freeze({
  open: Object.freeze(['none', 'pulling']),
  claimed: Object.freeze(['none', 'pulling']),
  submitted: Object.freeze(['none', 'landed']),
  verified: Object.freeze(['none', 'landed', 'published']),
  withdrawn: Object.freeze(['none', 'landed', 'pulling', 'published']),
});

/** Whether a status and landing value form a legal pair. */
export const legalLanding = (status, landing) => LANDINGS.includes(landing) && Object.hasOwn(LEGAL_LANDING, status) && LEGAL_LANDING[status].includes(landing);

/** The rule name that says what a job kind serves. */
export const servesRule = (kind) => `serves.${kind}`;

/** One row per declared item move, keyed `verb:from>to` (several from-states join with `|`). */
const itemRows = MACHINE.moves.map(move => ({ key: `${move.verb}:${move.from.join('|')}>${move.to}`, verb: move.verb, from: [...move.from], to: move.to, by: [...move.by], guards: [...(move.guards ?? [])] }));

const pinned = (snapshot) => snapshot.item?.commit === snapshot.job?.commit && snapshot.item?.digest === snapshot.job?.digest;
const everyItem = (snapshot, ok) => Array.isArray(snapshot.items) && snapshot.items.length > 0 && snapshot.items.every(ok);

/**
 * The backbone's rules over a snapshot `{ item, items, job, base, history }` (`base` is the current trunk tip, `history` the item's events, for its landing): the item's state facts, then one `serves.<kind>` fact per job kind.
 * Why: the serves facts are U152 rules, so a job's reason to exist is derived the same way as every guard.
 */
export const BACKBONE_RULES = defineRules({
  ...GUARD_RULES,
  ...APPLIED_RULES,
  ...KNOWN_RULES,
  claimed: { says: 'the item is claimed', holds: (s) => s.item?.status === 'claimed' },
  submitted: { says: 'the item is submitted', holds: (s) => s.item?.status === 'submitted' },
  noItem: { says: 'the job serves no item', holds: (s) => s.item === undefined || s.item === null },
  atJobCommit: { says: "the item is at the job's commit and frozen digest", holds: (s) => pinned(s) },
  verifiedUnmerged: { says: 'every item the job carries is verified and not yet merged', holds: (s) => everyItem(s, (i) => i.status === 'verified' && !i.merged) },
  [servesRule('gate')]: { says: JOB_KINDS[0].serves, reads: ['claimed', 'atJobCommit'], holds: (s, m, fact) => s.job?.kind === 'gate' && s.item?.owner === s.job.seat && fact('claimed') && fact('atJobCommit') },
  [servesRule('review')]: { says: JOB_KINDS[1].serves, reads: ['submitted', 'atJobCommit'], holds: (s, m, fact) => s.job?.kind === 'review' && fact('submitted') && fact('atJobCommit') && s.item.reservedBy === s.job.reviewer },
  [servesRule('landing-run')]: { says: JOB_KINDS[2].serves, reads: ['verifiedUnmerged'], holds: (s, m, fact) => s.job?.kind === 'landing-run' && fact('verifiedUnmerged') },
  [servesRule('landing')]: { says: JOB_KINDS[3].serves, reads: ['verifiedUnmerged'], holds: (s, m, fact) => s.job?.kind === 'landing' && fact('verifiedUnmerged') && everyItem(s, (i) => i.commit === s.job.commits?.[i.id]) },
  [servesRule('main-test')]: { says: JOB_KINDS[4].serves, reads: ['noItem'], holds: (s, m, fact) => s.job?.kind === 'main-test' && fact('noItem') },
  [servesRule('gate-verdict')]: { says: JOB_KINDS[5].serves, reads: ['submitted', 'atJobCommit'], holds: (s, m, fact) => s.job?.kind === 'gate-verdict' && fact('submitted') && fact('atJobCommit') },
  [servesRule('flake-diagnose')]: { says: JOB_KINDS[6].serves, holds: (s) => s.job?.kind === 'flake-diagnose' && s.job.verdict !== undefined },
  [servesRule('cells-inventory')]: { says: JOB_KINDS[7].serves, reads: ['noItem'], holds: (s, m, fact) => s.job?.kind === 'cells-inventory' && fact('noItem') },
  [servesRule('test-run')]: { says: JOB_KINDS[8].serves, holds: (s) => s.job?.kind === 'test-run' && typeof s.job.seat === 'string' },
  [servesRule('land')]: { says: JOB_KINDS[9].serves, reads: ['verifiedUnmerged'], holds: (s, m, fact) => s.job?.kind === 'land' && fact('verifiedUnmerged') && everyItem(s, (i) => i.acceptedAt === s.job.trunk) },
  [servesRule('gate-shard')]: { says: JOB_KINDS[10].serves, reads: ['submitted', 'atJobCommit'], holds: (s, m, fact) => s.job?.kind === 'gate-shard' && fact('submitted') && fact('atJobCommit') },
  [servesRule('test')]: { says: JOB_KINDS[11].serves, holds: (s) => s.job?.kind === 'test' && typeof s.job.seat === 'string' },
  [servesRule('screen')]: { says: JOB_KINDS[13].serves, reads: ['submitted'],
    holds: (s, m, fact) => s.job?.kind === 'screen' && fact('submitted') && s.item.pace === 'sprint' && s.item.commit === s.job.commit && Boolean(s.base) && s.job.base === s.base },
  [servesRule('pull-out')]: { says: JOB_KINDS[14].serves, holds: (s) => s.job?.kind === 'pull-out' && Boolean(s.item) && landingOf(s.item, s.history) === 'pulling' },
  [servesRule('check-baseline')]: { says: JOB_KINDS[12].serves, holds: (s) => s.job?.kind === 'check-baseline' && s.item?.check !== undefined && s.item.check !== null },
});

/**
 * The backbone table. `items` has one row per declared item move; `jobs` has one row per job kind, each naming its serves fact.
 * `states.start` is every stored item status and job kind but the final status; withdrawn is refused, since nothing leaves it.
 * Why: tableCoverage over statuses plus kinds fails the day either list grows a member the table does not name.
 */
export const BACKBONE_TABLE = Object.freeze({
  name: 'backbone',
  states: Object.freeze({
    start: Object.freeze([...MACHINE.states.filter(state => !state.final).map(state => state.id), ...JOB_KINDS.map(job => job.kind)]),
    refused: Object.freeze(MACHINE.states.filter(state => state.final).map(state => state.id)),
  }),
  items: Object.freeze(itemRows),
  jobs: Object.freeze(JOB_KINDS.map(job => Object.freeze({ kind: job.kind, serves: servesRule(job.kind) }))),
  guards: ITEM_GUARDS,
  outcomes: ITEM_OUTCOMES,
});

/** Every stored item status and job kind, the list tableCoverage runs over. */
export const BACKBONE_STATES = Object.freeze([...MACHINE.states.map(state => state.id), ...JOB_KINDS.map(job => job.kind)]);
