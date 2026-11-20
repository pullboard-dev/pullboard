/** The submit family as pure move tables: every rule `pullboard submit <id>` meets and every write it makes, ported from the pure-core pilot [C7,#8247]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';
import { SUBMIT_NEXT } from './next.js';
export { SUBMIT_NEXT } from './next.js';
export { SUBMIT_COMMAND_NEXT } from './next.js';

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
/** Any line break, the Unicode separators included (built with escapes so editors never write them raw). */
const LINE_BREAK = new RegExp("[\\r\\n\\u2028\\u2029]", "u");
const JOB = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** Each io field the shell reads before SUBMIT or COMMIT: null when the rule holds, else its refusal {code, message, next}. */
export const IO_FIELDS = Object.freeze({
  hosted: 'process env + git push: an item-folder runner hand-off (HOSTED_BRANCH_MISMATCH, DIRTY, HOSTED_PUSH_FAILED, RUNNER_NOT_REGISTERED)',
  recovered: 'filesystem: an unrecorded relay-recovered submit replays instead (MAIN_NOT_COMPOSED, KERNEL_*, STACKED_ON_UNVERIFIED)',
  notJoinedGuidance: 'git + filesystem: the session seats named by the NOT_JOINED wording, {message, next}',
  folderItem: 'filesystem: the item this item folder belongs to, or null (NOT_YOURS)',
  heldElsewhere: 'git + session digest: the holder seat when it works in another checkout, {agent, path} or null (NOT_YOURS)',
  dirty: 'git: uncommitted changes, plus the spec grammar check (DIRTY / A5_GRAMMAR_VERSION)',
  untracked: 'git: untracked files (UNTRACKED)',
  noCommit: 'git: HEAD has no commit (NO_COMMIT)',
  mainMerge: 'git: automatic main merge into the candidate; refusal (MERGE_CONFLICT) or {merged, source, main, commit}',
  empty: 'git: the head changes nothing against accepted main (EMPTY_SUBMIT)',
  trunkMerge: 'git: the candidate merges cleanly with trunk, or a recorded tool change regenerates (MERGE_CONFLICT / SUBMIT_HANDOFF_PENDING)',
  provesNothing: 'git + process: the frozen check is already green on main (CRITERION_PROVES_NOTHING)',
  kernelApproval: 'git: an exact Kernel front-door change is approved (KERNEL_EXPORT_APPROVAL / KERNEL_EXPORT_SOURCE)',
  currentDigest: 'git + filesystem: today\'s freeze of the item\'s cited rows, digest or {unusable} (CRITERIA_CHANGED)',
  familyProblem: 'git: accepted policy verify.family at the submission policy commit (UNDECLARED_BUILDER_FAMILY)',
  itemPatches: 'filesystem + git: companion patch input and composition (ITEM_PATCH_*)',
  handoffExecution: 'git: the worker\'s captured execution source matches (SUBMIT_HANDOFF_SOURCE)',
  redLoop: 'git + receipts: two red test gates still match the item\'s net diff (SUBMIT_RED_LOOP)',
  composition: 'git: the candidate contains the main its proof pins (MAIN_NOT_COMPOSED), when bar-ready is on',
  stack: 'git + board: no unverified earlier item commits under the candidate (STACKED_ON_UNVERIFIED / WRONG_BRANCH)',
  hostName: 'git: no commit message names this machine (HOST_NAME)',
  infraNote: 'git: infra-only diffs carry a note when submit.requireInfraNote (INFRA_NOTE)',
  companionDigest: 'git: digest of the companion patches bound to this commit (SUBMIT_HANDOFF_CHANGED)',
  ownership: 'git: changed paths against lane ownership, raised after the gate (OUTSIDE_LANE)',
  postGate: 'git + runners: moved during gate, cells, ratchet, test selection (MOVED_DURING_GATE, CELLS_*, RATCHET_*, TEST_SELECTION_*)',
  head: 'git: the checked-out HEAD commit and tree, echoed into the submit',
  keepSeat: 'process: whether a hand-off failure came from the gate result (keep the seat) or its driver (return to board)',
});

/** What the shell hands in after io it ran itself; the table never computes these. */
export const SHELL_INPUTS = Object.freeze({
  gate: 'the gate run: {refusal} when red or refused (GATE_RED, RUNNER_*, SLOT_DB_LOCKED, ...), else {green, proof, size, tooling, policyCommit}',
  result: 'a hand-off worker\'s canonical result: {code: 0, commit} or {code: 1, error: {code, message, next}}',
  retryJob: 'a fresh job UUID for a requeue (crypto)',
});

/** Board-data rules the prototype did not port; the shell computes them with today's functions. */
export const DEFERRED_FIELDS = Object.freeze({
  barProblem: 'barReadyProblem: required family + signed bar (BAR_NOT_READY / UNDECLARED_BUILDER_FAMILY)',
  clauseProblem: 'clauseInspectionProblem over facts and proof files when verify.inspectClauses (CLAUSE_*)',
  reviewProblem: 'refuseUnreviewable: some eligible reviewer exists for the submitted item (NO_ELIGIBLE_REVIEWER)',
  proofRecord: 'submissionProof/known-main normalisation of the gate proof (SUBMISSION_PROOF, KNOWN_MAIN_*)',
  barWarning: 'barCheckWarning: bar.check warning text, recorded as a fact',
  mergeOnly: 'prepareMergeOnlySubmit: carried acceptance on a conflict return (MERGE_ONLY_PROOF, SELF_VERIFY, PROOF_REQUIRED); 1 use in 4 days',
  ownershipWait: 'ownershipWaitForJob: an immutable ownership-wait receipt for this job (SUBMIT_HANDOFF_RESULT)',
  builderFamily: 'seatFamily: the builder\'s vendor family, stamped on the item',
});

const leaseLive = s => (s.item.leaseUntil ?? '') > s.now;
const holds = (s, m) => s.item.status === 'claimed' && s.item.owner === m.actor;
const queues = (s, m) => s.config.handoff === true && m.worker !== true;

/** Fields of an unadopted coordinator correction since the last refreeze (pendingRefreeze in read/shouts.js). */
export function pendingRefreeze(s) {
  const last = Math.max(0, ...s.history.filter(e => e.kind === 'refreeze' || (['claim', 'renew'].includes(e.kind) && e.detail.adoptedCorrection != null)).map(e => e.id));
  const fields = new Set();
  for (const e of s.history.filter(e => e.kind === 'edit' && e.id > last).reverse()) {
    if (e.detail.correctedFrozen) break;
    for (const field of e.detail.pendingRefreeze ?? []) if (['after', 'criterion', 'check'].includes(field)) fields.add(field);
  }
  return [...fields].sort();
}

/** HEAD_NOT_NEW: the commit was already rejected at this bar, or the item already sits at it with no verdict (headIsNew). */
function headSeen(s, commit) {
  const rejected = s.rejects.some(r => r.commit === commit && r.digest === s.item.frozenDigest);
  const reopened = s.item.verdict === null && s.item.commit === commit && !s.deferred.correctedReopen;
  return rejected || reopened;
}

/** The pipeline cause of a refusal, classified from explicit codes only (kernel cause.js, copied: it is a rule). */
export function pipelineCause({ code, note = '' }) {
  const CODES = { RUNNER_WAIT_DEADLINE: 'runner-wait', FLAKE: 'flake', MAIN_RED: 'main-red', CRITERIA_CHANGED: 'bar-change', PENDING_REFREEZE: 'bar-change',
    MERGE_CONFLICT: 'conflict', TRUNK_CONFLICT: 'conflict', ITEM_PATCH_CHANGED: 'companion-wait', TEST_FAILURE: 'test-failure', BOARD_BUSY: 'host-busy',
    GIT_READ_INFRASTRUCTURE: 'host-busy', DATABASE_LOCKED: 'host-busy' };
  const type = Object.hasOwn(CODES, code) ? CODES[code] : null;
  if (type) return { type, ...(code ? { code } : {}) };
  return { type: 'other', text: String(note).slice(0, 4000) || String(code ?? 'No structured cause was supplied'), ...(code ? { code } : {}) };
}


/**
 * Build the submit rules and the six tables (SUBMIT, COMMIT, OUTCOME, START, COMPLETE, RECAPTURE) over the board's own retry limit and infrastructure codes.
 * Why: moves may not reach into the store, and these two must stay one source; the caller passes the store's `INFRASTRUCTURE_RETRY_LIMIT` and
 * `INFRASTRUCTURE_CODES` (as release.table.js takes the release reasons), so there is no second copy to drift.
 *
 * @param {{ retryLimit: number, infrastructureCodes: ReadonlySet<string> | readonly string[] }} board
 * @returns {{ rules: Readonly<Record<string, object>>, tables: Readonly<Record<'SUBMIT' | 'COMMIT' | 'OUTCOME' | 'START' | 'COMPLETE' | 'RECAPTURE', object>> }}
 */
export function submitEngine(board) {
  if (!Number.isSafeInteger(board?.retryLimit) || board.retryLimit < 1 || !board?.infrastructureCodes || typeof board.infrastructureCodes[Symbol.iterator] !== 'function') {
    throw new Refused('SUBMIT_TABLE_INPUTS', 'the submit tables need the infrastructure retry limit and the infrastructure stop codes', "pass INFRASTRUCTURE_RETRY_LIMIT and INFRASTRUCTURE_CODES from the store's front door");
  }
  const INFRASTRUCTURE_RETRY_LIMIT = board.retryLimit;
  const INFRASTRUCTURE_CODES = new Set(board.infrastructureCodes);
  const RECOVERED_STOPS = new Set(['GATE_INFRA_EXHAUSTED', 'SUBMIT_HANDOFF_DEAD']);
  const infrastructureStop = error => INFRASTRUCTURE_CODES.has(error.code)
    || (error.code === 'SUBMIT_HANDOFF_EXIT' && ((typeof error.signal === 'string' && error.signal !== '') || /\bSIG[A-Z0-9]+\b/u.test(String(error.message ?? ''))));
const DEFS = {};
/** Register a guard's rule once under its row id: it holds when the guard's refusal condition does not. */
function row(o) {
  DEFS[o.id] = { says: o.rule, holds: (s, m) => !o.refuses(s, m) };
  return { id: o.id, requires: o.id, code: o.code, message: o.message, next: o.next, ...(o.codeOf ? { codeOf: o.codeOf } : {}), ...(o.recordsOutcome ? { recordsOutcome: true } : {}), ...(o.io ? { io: true } : {}), ...(o.deferred ? { deferred: true } : {}) };
}
const guard = (id, code, rule, refuses, message, extra = {}) => row({ id, code, rule, refuses, message, next: extra.next ?? SUBMIT_NEXT[code] ?? SUBMIT_NEXT.USAGE, ...extra });
/** A rule the shell decides with io: the row only orders it and passes its refusal through. */
const ioGuard = (id, field, rule, extra = {}) => row({ id, code: extra.code ?? `io:${field}`, rule, io: true, refuses: (s) => Boolean(s.io[field]?.code),
  message: s => s.io[field].message, next: s => s.io[field].next, ...extra });
const deferredGuard = (id, field, rule, extra = {}) => row({ id, code: `deferred:${field}`, rule, deferred: true, refuses: (s) => Boolean(s.deferred[field]?.code),
  message: s => s.deferred[field].message, next: s => s.deferred[field].next, ...extra });
/** Name each outcome's and follow-up's `when` as a rule, so the engine reads every decision as a named fact. */
function bind(table) {
  const named = (kind, entry) => {
    if (typeof entry.when !== 'function') return entry;
    const name = `${table.move}:${kind}:${entry.id}`;
    DEFS[name] = { says: `${table.move} takes ${entry.id}`, holds: entry.when };
    return { ...entry, when: name };
  };
  return Object.freeze({ ...table, name: table.move, outcomes: table.outcomes.map(o => named('outcome', o)), followups: table.followups.map(f => named('followup', f)) });
}
/** Board guards both the pre-gate dry run and the post-gate write check (moveItem's submit guards, in order). */
function boardGuards(phase) {
  return [
    ioGuard(`${phase}:builder-family`, 'familyProblem', 'a strict item is submitted by a builder with a declared vendor family'),
    guard(`${phase}:outside`, 'OUTSIDE_NATIVE_BUILD', 'an outside PR item stays with its author', s => s.item.outside === 'pull-request',
      (s, m) => `outside item #${m.id} stays with its PR author; ask the coordinator to return it, then intake the author's new exact head`),
    guard(`${phase}:children`, 'CHILDREN_OPEN', 'a parent is submitted only once its children are finished',
      s => s.children.some(c => ['open', 'claimed', 'submitted'].includes(c.status)),
      (s, m) => `item #${m.id} has ${s.children.filter(c => ['open', 'claimed', 'submitted'].includes(c.status)).length} unfinished child items`),
    guard(`${phase}:head-new`, 'HEAD_NOT_NEW', 'rework comes back only at a new head', (s, m) => headSeen(s, m.commit ?? s.io.head?.commit),
      (s, m) => `#${m.id} already has a submission at ${String(m.commit ?? s.io.head?.commit).slice(0, 12)}; commit the rework first`),
  ];
}

const SUBMIT = ({
  move: 'submit',
  guards: [
    guard('companion-usage', 'USAGE', 'a companion patch names its file, key and author',
      (s, m) => m.companion !== undefined && (!m.companion?.file || !m.companion?.key || !m.companion?.author),
      'use pullboard submit <id> --companion <patch-file> --key <key> --author <owning-seat>'),
    ioGuard('hosted-runner', 'hosted', 'an item-folder runner pushes the claimed branch before submitting'),
    ioGuard('recovered', 'recovered', 'an unrecorded recovered submit replays only with proof for current main'),
    guard('joined', 'NOT_JOINED', 'the caller is a joined seat', s => !s.actor.joined, s => s.io.notJoinedGuidance?.message ?? 'this checkout has not joined a lane',
      { next: s => s.io.notJoinedGuidance?.next ?? 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)' }),
    guard('item-exists', 'NO_ITEM', 'the item exists', s => !s.item, (s, m) => `no item #${m.id}; see: pullboard list`),
    guard('folder-item', 'NOT_YOURS', 'an item folder submits only its own item', (s, m) => s.io.folderItem != null && s.io.folderItem !== m.id,
      s => `this folder belongs to item #${s.io.folderItem}; submit that item from here`),
    guard('held-here', 'NOT_YOURS', 'a claim is submitted from its holder\'s own checkout', (s, m) => m.worker !== true && s.item.status === 'claimed' && Boolean(s.io.heldElsewhere),
      (s, m) => `#${m.id} is held by ${s.io.heldElsewhere.agent} in ${s.io.heldElsewhere.path}, not by this checkout`,
      { next: (s, m) => `submit it from that seat's checkout: ${cdTo(s.io.heldElsewhere.path)} pullboard submit ${m.id}` }),
    guard('holder', 'NOT_YOURS', 'only the holder of a claim submits it', (s, m) => !holds(s, m), 'claim this item before submitting it'),
    deferredGuard('bar-ready', 'barProblem', 'a required family is declared and a required bar is signed'),
    deferredGuard('clauses', 'clauseProblem', 'each frozen clause is ticked with its evidence kind'),
    guard('correction-refrozen', 'PENDING_REFREEZE', 'a pending coordinator correction is refrozen first (the command re-claims, and claim refuses)',
      s => pendingRefreeze(s).length > 0,
      (s, m) => `item #${m.id} has a pending ${pendingRefreeze(s).join(' and ')} correction; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${m.id}`),
    // ---- From here a refusal is followed by the OUTCOME move (the command's submitAttempt is set). ----
    ioGuard('tree-clean', 'dirty', 'the tree is committed: the gate checks what is submitted', { recordsOutcome: true }),
    ioGuard('nothing-untracked', 'untracked', 'no untracked files', { recordsOutcome: true }),
    ioGuard('has-commit', 'noCommit', 'something is committed', { recordsOutcome: true }),
    ioGuard('main-merge', 'mainMerge', 'accepted main merges into the candidate', { recordsOutcome: true }),
    ioGuard('non-empty', 'empty', 'the submitted source changes accepted main', { recordsOutcome: true }),
    ioGuard('trunk-merge', 'trunkMerge', 'the candidate composes with trunk', { recordsOutcome: true }),
    ioGuard('proves-something', 'provesNothing', 'a check already green on main proves nothing', { recordsOutcome: true }),
    ioGuard('kernel-approval', 'kernelApproval', 'the person approved the exact Kernel front-door change', { recordsOutcome: true }),
    guard('criterion-unchanged', 'CRITERIA_CHANGED', 'the cited rows still freeze to the claimed digest',
      s => s.item.frozenDigest !== null && s.io.currentDigest != null && s.io.currentDigest.digest !== s.item.frozenDigest,
      (s, m) => `the spec rows #${m.id} cites changed after it was claimed${s.io.currentDigest.unusable ? ` (${s.io.currentDigest.unusable})` : ''}, so no verifier could judge it; ${s.io.currentDigest.unusable
        ? `the coordinator either restores the row and runs pullboard refreeze ${m.id}, or withdraws #${m.id}` : `${m.actor === 'coordinator' ? '' : 'the coordinator runs '}pullboard refreeze ${m.id}, then you claim it and submit again`}`,
      { recordsOutcome: true }),
    // The preflight dry run: today a rolled-back submit transaction; here simply the board rows, run early.
    ...boardGuards('preflight').map(g => ({ ...g, recordsOutcome: true })),
    deferredGuard('reviewable', 'reviewProblem', 'some eligible reviewer can judge the submitted item', { recordsOutcome: true }),
    ioGuard('item-patches', 'itemPatches', 'companion patches are well formed, authored in an owning lane and composed', { recordsOutcome: true }),
    ioGuard('handoff-execution', 'handoffExecution', 'a worker executes its captured source', { recordsOutcome: true }),
    ioGuard('red-progress', 'redLoop', 'two red gates on unchanged code stop another submit', { recordsOutcome: true, refuses: (s, m) => !(m.worker !== true && pendingHandoff(s)) && Boolean(s.io.redLoop?.code) }),
    ioGuard('composition', 'composition', 'the candidate contains the main its proof pins', { recordsOutcome: true }),
    ioGuard('stack', 'stack', 'nothing unverified is stacked under the candidate', { recordsOutcome: true }),
    ioGuard('host-name', 'hostName', 'no commit names this machine', { recordsOutcome: true }),
    ioGuard('infra-note', 'infraNote', 'an infra-only change carries its note', { recordsOutcome: true }),
    // ---- The queued hand-off (queueSubmitHandoff), only when submit.handoff is on and this is not the worker ----
    guard('handoff-candidate', 'BAD_SUBMIT_HANDOFF', 'a queued candidate is a clean committed source with its exact frozen bar',
      (s, m) => queues(s, m) && !(Number.isSafeInteger(s.config.leaseMs) && s.config.leaseMs > 0 && JOB.test(m.job ?? '') && SHA.test(s.io.head?.main ?? '')
        && SHA.test(s.io.head?.commit ?? '') && SHA.test(s.io.head?.tree ?? '') && DIGEST.test(s.item.frozenDigest ?? '') && (s.io.companionDigest == null || DIGEST.test(s.io.companionDigest))),
      'queue a clean committed candidate with its exact frozen bar', { recordsOutcome: true }),
    guard('handoff-live-claim', 'NOT_YOURS', 'only a live claim queues a gate', (s, m) => queues(s, m) && !(holds(s, m) && leaseLive(s)),
      'claim this item before submitting it', { recordsOutcome: true }),
    guard('handoff-pending', 'SUBMIT_HANDOFF_PENDING', 'an unfinished queued candidate is kept until its result',
      (s, m) => queues(s, m) && Boolean(pendingHandoff(s)) && !sameCandidate(s, pendingHandoff(s)),
      'the original queued candidate is still running; leave it unchanged and take other work with pullboard next', { recordsOutcome: true }),
  ],
  outcomes: [
    { id: 'precheck', when: (s, m) => m.precheck === true, patch: () => ({}), events: () => [] },
    { id: 'queue-existing', when: (s, m) => queues(s, m) && Boolean(pendingHandoff(s)), patch: () => ({}), events: () => [] },
    { id: 'queue', when: (s, m) => queues(s, m), patch: () => ({}),
      events: (s, m) => [{ kind: 'submit-handoff', by: m.actor, detail: { state: 'queued', commit: s.io.head.commit } }],
      record: (s, m) => ({ version: 1, id: m.job, agentId: m.actor, commit: s.io.head.commit, tree: s.io.head.tree, main: s.io.head.main,
        executionCommit: s.io.head.executionCommit ?? s.io.head.commit, executionTree: s.io.head.executionTree ?? s.io.head.tree, digest: s.item.frozenDigest,
        companionDigest: s.io.companionDigest ?? null, leaseMs: s.config.leaseMs, state: 'queued', at: s.now }) },
    { id: 'gate', when: () => true, patch: () => ({}), events: () => [] },
  ],
  followups: [
    { id: 'main-merge-fact', rule: 'an automatic main merge is recorded as a note before the gate',
      when: (s, m) => m.precheck !== true && s.before.io.mainMergeResult?.merged === true,
      apply: ({ before: s }) => ({ patch: {}, events: [{ kind: 'fact', by: s.item.owner, detail: { kind: 'note',
        text: `Builder ${s.item.owner} automatic main merge: source ${s.io.mainMergeResult.source}, main ${s.io.mainMergeResult.main}, merge ${s.io.mainMergeResult.commit}.` } }] }) },
    { id: 'bar-warning-fact', rule: 'a bar.check warning is recorded as a note before the gate',
      when: (s, m) => m.precheck !== true && Boolean(s.before.deferred.barWarning),
      apply: ({ before: s }) => ({ patch: {}, events: [{ kind: 'fact', by: s.item.owner, detail: { kind: 'note', text: `bar.check warning: ${s.deferred.barWarning}` } }] }) },
  ],
});

/** The current hand-off when it is queued or running for this claim at its frozen bar (pendingSubmitHandoff). */
function pendingHandoff(s) {
  const job = s.handoff;
  return job && s.item.status === 'claimed' && job.agentId === s.item.owner && job.digest === s.item.frozenDigest && ['queued', 'running'].includes(job.state) ? job : null;
}
const sameCandidate = (s, job) => job.commit === s.io.head?.commit && job.tree === s.io.head?.tree && job.digest === s.item.frozenDigest && job.companionDigest === (s.io.companionDigest ?? null);
const cdTo = path => `cd ${/^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replace(/'/gu, `'\\''`)}'`} &&`;

const COMMIT = ({
  move: 'submit-commit',
  guards: [
    ioGuard('gate', 'gate', 'the gate ran green on this exact commit (GATE_RED, runner and slot refusals)', { recordsOutcome: true, refuses: (s) => Boolean(s.gate?.refusal),
      message: s => s.gate.refusal.message, next: s => s.gate.refusal.next, codeOf: s => s.gate.refusal.code }),
    ioGuard('ownership', 'ownership', 'the changed paths stay in the lane (raised after the gate)', { recordsOutcome: true }),
    ioGuard('post-gate', 'postGate', 'the tree stayed still during the gate, and cells, ratchet and test selection hold', { recordsOutcome: true }),
    guard('note-one-line', 'USAGE', 'a submission note, when present, is one nonempty line',
      (s, m) => m.note !== undefined && (typeof m.note !== 'string' || !m.note.trim() || LINE_BREAK.test(m.note)),
      'a submission note, when present, is one nonempty line', { recordsOutcome: true }),
    // moveItem: the item must still be claimed by the caller after the gate (IN_STATE, isHolder).
    guard('still-held', 'NOT_YOURS', 'the item is still claimed by the caller after the gate', (s, m) => !holds(s, m),
      (s, m) => `item #${m.id} is not claimed by you; claim it first`, { recordsOutcome: true }),
    ...boardGuards('write').map(g => g.id === 'write:builder-family' ? { ...g, recordsOutcome: true } : { ...g, recordsOutcome: true }),
    guard('write:correction-refrozen', 'PENDING_REFREEZE', 'a pending coordinator correction is refrozen first', s => pendingRefreeze(s).length > 0,
      (s, m) => `item #${m.id} has a pending ${pendingRefreeze(s).join(' and ')} correction; refreeze it before renewing or submitting.\nnext: pullboard refreeze ${m.id}`, { recordsOutcome: true }),
    deferredGuard('write:bar-ready', 'barProblem', 'a required family is declared and a required bar is signed', { recordsOutcome: true }),
    deferredGuard('write:clauses', 'clauseProblem', 'each frozen clause is ticked with its evidence kind', { recordsOutcome: true }),
    deferredGuard('write:merge-only', 'mergeOnlyProblem', 'a carried acceptance matches its recorded conflict return', { recordsOutcome: true }),
  ],
  outcomes: [
    { id: 'submit', when: () => true,
      patch: (s, m) => ({ status: 'submitted', builtBy: m.actor, builderFamily: s.deferred.builderFamily ?? null, commit: m.commit, tree: m.tree, leaseUntil: null,
        reviewBy: null, reviewUntil: null, files: [...new Set([...(s.item.files ?? []), ...(m.files ?? [])])] }),
      events: (s, m) => [{ kind: 'submit', by: m.actor, detail: submitDetail(s, m) }] },
  ],
  followups: [],
});

/** The submit event detail, key for key as recordSubmissionEvent writes it today. */
function submitDetail(s, m) {
  const g = s.gate ?? {};
  return {
    commit: m.commit, tree: m.tree,
    ...(g.policyCommit ? { policyCommit: g.policyCommit } : {}),
    ...(s.item.frozenDigest ? { criterionDigest: s.item.frozenDigest } : {}),
    ...(m.note === undefined ? {} : { note: m.note.trim() }),
    ...(s.deferred.proofRecord ? { submissionProof: s.deferred.proofRecord } : {}),
    ...(m.infra ? { infra: m.infra } : {}),
    ...(g.green !== undefined ? { gateGreen: g.green === true } : {}),
    ...(s.deferred.mergeOnly ? { mergeOnly: s.deferred.mergeOnly } : {}),
    ...(g.size ? { submissionSize: g.size } : {}),
    ...(m.companionRecord ? { companion: m.companionRecord } : {}),
    ...(m.quarantineProofIds !== undefined ? { quarantineProofIds: [...m.quarantineProofIds] } : {}),
    ...(typeof g.tooling === 'string' && /^[a-f0-9]{40,64}$/u.test(g.tooling) ? { tooling: g.tooling } : {}),
  };
}

/**
 * The refusal renewal: after a refusal past the claim check, the command renews the claim and records why (run() in
 * commands/submit.js, then checkedSubmitOutcome in claim). A claim that moved on is left alone and nothing is written.
 * The renewal itself then passes the ordinary claim table (claim.table.js) with `deferred.submitOutcome` set to this detail.
 */
const OUTCOME = ({
  move: 'submit-outcome',
  guards: [
    guard('outcome-shape', 'USAGE', 'a submit outcome keeps its actual refusal code and a bounded explanation',
      (s, m) => !/^[A-Z][A-Z0-9_]*$/u.test(m.refusal.code ?? '') || typeof m.refusal.text !== 'string' || !m.refusal.text.trim(),
      'a submit outcome retains its actual refusal code and bounded explanation'),
  ],
  outcomes: [
    { id: 'skip', when: (s, m) => !(holds(s, m) && s.item.frozenDigest === m.digest && leaseLive(s)), patch: () => ({}), events: () => [] },
    { id: 'renew', when: () => true, patch: () => ({}), events: () => [], submitOutcome: (s, m) => outcomeDetail(m.refusal.code, m.refusal.text.slice(0, 4000), m.digest, m.stage) },
  ],
  followups: [],
});

/** The submitOutcome a renewal records (checkedSubmitOutcome; returnToBuilder writes the same fields without a stage). */
function outcomeDetail(code, text, digest, stage) {
  return { code, text, digest, ...(stage === 'fast' ? { stage: 'fast' } : {}), pipelineCause: pipelineCause({ code, note: text }) };
}

/** Whether a hand-off still serves its item: claimed by its seat at its frozen digest. */
const serving = (s, job) => s.item.status === 'claimed' && s.item.owner === job.agentId && s.item.frozenDigest === job.digest;
const matches = (s, m) => Boolean(s.handoff) && s.handoff.id === m.job && s.handoff.agentId === m.actor;
const handoffEvent = (job) => ({ kind: 'submit-handoff', by: job.agentId, detail: { state: job.state, commit: job.commit } });

const START = ({
  move: 'start-submit-handoff',
  guards: [
    guard('start-matching', 'SUBMIT_HANDOFF_CHANGED', 'a worker acts only for its exact current job and sender', (s, m) => !matches(s, m),
      'read the current queued submission; an old or foreign worker cannot complete it'),
    deferredGuard('start-hook-proof', 'hookProofProblem', 'a merge hook needs this exact job, source, bar and green receipts'),
    guard('start-retry-id', 'BAD_SUBMIT_HANDOFF', 'a recovery needs a fresh job identity', (s, m) => m.retryJob !== undefined && (!JOB.test(m.retryJob) || m.retryJob === m.job),
      'recovery needs a fresh job identity'),
    guard('start-running-serves', 'SUBMIT_HANDOFF_CHANGED', 'a running gate resumes only while its claim and bar still match',
      (s, m) => !m.hook && m.unrecoverable === undefined && m.retryJob === undefined && s.handoff.state === 'running' && !serving(s, s.handoff),
      'the running claim or frozen bar changed; do not resume its old gate'),
    guard('start-queued-serves', 'SUBMIT_HANDOFF_CHANGED', 'a queued gate starts only while its claim and bar still match',
      (s, m) => !m.hook && m.unrecoverable === undefined && m.retryJob === undefined && s.handoff.state === 'queued' && !serving(s, s.handoff),
      'the queued claim or frozen bar changed; do not run its old gate'),
  ],
  outcomes: [
    { id: 'hook', when: (s, m) => Boolean(m.hook), patch: () => ({}), events: s => [handoffEvent(s.handoff)], record: (s, m) => ({ ...s.handoff, hookProjection: { ...m.hook, at: s.now } }) },
    { id: 'spend', when: (s, m) => m.unrecoverable !== undefined && s.handoff.state === 'infrastructure' && (s.handoff.infrastructureRetries ?? 0) < INFRASTRUCTURE_RETRY_LIMIT && !s.handoff.infrastructureNotified,
      patch: () => ({}), events: (s, m) => [shoutEvent('sentinel', 'coordinator', `Queued gate #${m.id} exhausted ${INFRASTRUCTURE_RETRY_LIMIT} healthy-executor recovery retries (${s.handoff.error?.code}) at ${String(s.handoff.commit).slice(0, 12)}; its captured tools cannot be recovered (${String(m.unrecoverable).slice(0, 160)}). Restore the runner and requeue the captured candidate. No builder red.`), handoffEvent(s.handoff)],
      record: s => ({ ...s.handoff, infrastructureRetries: INFRASTRUCTURE_RETRY_LIMIT, infrastructureNotified: true }) },
    { id: 'spend-nothing', when: (s, m) => m.unrecoverable !== undefined, patch: () => ({}), events: () => [] },
    { id: 'retry', when: (s, m) => m.retryJob !== undefined && s.handoff.state === 'infrastructure' && RECOVERED_STOPS.has(s.handoff.error?.code)
        && (s.handoff.infrastructureRetries ?? 0) < INFRASTRUCTURE_RETRY_LIMIT && serving(s, s.handoff) && leaseLive(s) && s.io.companionDigest === s.handoff.companionDigest,
      patch: () => ({}), events: (s) => [handoffEvent({ ...s.handoff, state: 'queued' })], record: (s, m) => retried(s, m) },
    { id: 'retry-nothing', when: (s, m) => m.retryJob !== undefined, patch: () => ({}), events: () => [] },
    { id: 'already-started', when: s => s.handoff.state !== 'queued', patch: () => ({}), events: () => [] },
    { id: 'start', when: () => true, patch: () => ({}), events: s => [handoffEvent({ ...s.handoff, state: 'running' })], record: s => ({ ...s.handoff, state: 'running', startedAt: s.now }) },
  ],
  followups: [],
});

/** A queued gate takes the newest main: the move recaptureSubmitHandoff makes, shaped like START and restating the refusals of retry.js [C7,#9548]. */
const RECAPTURE = ({
  move: 'recapture-submit-handoff',
  guards: [
    guard('recapture-main', 'BAD_SUBMIT_HANDOFF', 'a recapture names the newest main as a full commit sha', (s, m) => !SHA.test(m.main ?? ''),
      'a recapture needs the newest main as a 40-character commit sha'),
    guard('recapture-matching', 'SUBMIT_HANDOFF_CHANGED', 'a recapture acts only for its exact current job and sender', (s, m) => !matches(s, m),
      'read the current queued submission; an old or foreign worker cannot complete it'),
    guard('recapture-queued-serves', 'SUBMIT_HANDOFF_CHANGED', 'only the queued gate of the live claim at its frozen bar can recapture main',
      (s) => s.handoff.state !== 'queued' || !serving(s, s.handoff),
      'only the queued gate of the live claim at its frozen bar can recapture main; read the current queued submission'),
  ],
  outcomes: [
    { id: 'recapture', when: () => true, patch: () => ({}), events: s => [handoffEvent(s.handoff)], record: (s, m) => ({ ...s.handoff, main: m.main }) },
  ],
  followups: [],
});

/** A requeued successor: same captured source, fresh id, one more retry (retryStoppedHandoff). */
function retried(s, m) {
  const next = { ...s.handoff, id: m.retryJob, state: 'queued', at: s.now, infrastructureRetries: (s.handoff.infrastructureRetries ?? 0) + 1, retryOf: s.handoff.id,
    ...(typeof s.handoff.error?.reason === 'string' ? { requeuedFor: s.handoff.error.reason } : {}) };
  for (const field of ['error', 'completedAt', 'startedAt', 'hookProjection', 'infrastructureNotified']) delete next[field];
  return next;
}

const shoutEvent = (from, to, text) => ({ kind: 'shout', by: from, item: null, detail: { to, text } });
const live = (s, m) => (s.handoff ? ['queued', 'running'].includes(s.handoff.state) : false);
const failed = (s, m) => m.result?.code !== 0;
const redReturns = (s, m) => s.item.status !== 'submitted' && serving(s, s.handoff);

/** The lock waits a queued gate sat through, as a job field (lockWaitRecord): shell input from the worker's result. */
function lockWaits(m) {
  const waits = m.result?.lockWaits, count = Number(waits?.count), totalMs = Number(waits?.totalMs);
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(totalMs) || totalMs < 0) return {};
  return { lockWaits: { count, totalMs, codes: Object.fromEntries(Object.entries(waits.codes ?? {}).filter(([code, n]) => /^[A-Z_]{1,40}$/u.test(code) && Number.isSafeInteger(n) && n > 0)) } };
}

const COMPLETE = ({
  move: 'complete-submit-handoff',
  guards: [
    guard('complete-matching', 'SUBMIT_HANDOFF_CHANGED', 'a worker acts only for its exact current job and sender', (s, m) => !matches(s, m),
      'read the current queued submission; an old or foreign worker cannot complete it'),
    deferredGuard('ownership-wait', 'ownershipWaitProblem', 'an ownership wait carries its own immutable receipt'),
    guard('green-is-submitted', 'SUBMIT_HANDOFF_RESULT', 'a queue result never replaces the normal proved submit transition',
      (s, m) => live(s, m) && !s.deferred.ownershipWait && m.result?.code === 0 && !(s.item.status === 'submitted' && s.item.builtBy === s.handoff.agentId && s.item.commit === m.result.commit),
      'a queue result cannot replace the normal proved submit transition'),
    guard('green-is-proved', 'SUBMIT_HANDOFF_RESULT', 'a green result needs its own submit event and captured-source proof receipts',
      (s, m) => live(s, m) && !s.deferred.ownershipWait && m.result?.code === 0 && !greenProved(s, m),
      'the queued source needs its own actual native submit event and captured-source proof receipts'),
    guard('refusal-document', 'BAD_SUBMIT_HANDOFF', 'a failure keeps the exact canonical refusal document',
      (s, m) => live(s, m) && !s.deferred.ownershipWait && failed(s, m) && !(m.result?.code === 1 && m.result.error && typeof m.result.error.code === 'string' && m.result.error.code
        && typeof m.result.error.message === 'string' && typeof m.result.error.next === 'string'),
      'retain the exact canonical refusal document before completing this queued gate'),
  ],
  outcomes: [
    { id: 'already-done', when: (s) => !['queued', 'running'].includes(s.handoff.state), patch: () => ({}), events: () => [] },
    { id: 'ownership-wait', when: s => Boolean(s.deferred.ownershipWait), patch: () => ({}), events: s => [handoffEvent({ ...s.handoff, state: 'ownership-wait' })],
      record: (s, m) => ({ ...s.handoff, ...lockWaits(m), ...lockWaits(m), state: 'ownership-wait', gateGreen: false, ownershipWait: s.deferred.ownershipWait.key, completedAt: s.now }) },
    { id: 'green', when: (s, m) => m.result.code === 0, patch: () => ({}),
      events: (s, m) => [handoffEvent({ ...s.handoff, state: latestSubmit(s).gateGreen === true ? 'green' : 'submitted' })],
      record: (s, m) => ({ ...s.handoff, ...lockWaits(m), state: latestSubmit(s).gateGreen === true ? 'green' : 'submitted', gateGreen: latestSubmit(s).gateGreen === true, submitted: m.result.commit, completedAt: s.now }) },
    { id: 'infrastructure', when: (s, m) => m.result.error.code === 'SUBMIT_HANDOFF_DEAD' || (infrastructureStop(m.result.error) && s.item.status !== 'submitted'),
      patch: () => ({}), events: (s, m) => [...infrastructureShouts(s, m), handoffEvent({ ...s.handoff, state: 'infrastructure' })],
      record: (s, m) => { const exhausted = m.windowSpent === true || (s.handoff.infrastructureRetries ?? 0) >= INFRASTRUCTURE_RETRY_LIMIT;
        return { ...s.handoff, ...lockWaits(m), state: 'infrastructure', error: { ...m.result.error }, completedAt: s.now, ...(m.windowSpent === true ? { infrastructureRetries: INFRASTRUCTURE_RETRY_LIMIT } : {}),
          ...(exhausted || !RECOVERED_STOPS.has(m.result.error.code) ? { infrastructureNotified: true } : {}) }; } },
    // returnToBoard runs only for a driver failure with claim.returnToBoard on (failureCompletion's keepSeat); boardCodes (set by the retry writer at boards at or above BOARD_RELEASE_CODES_ENGINE) names the release GATE_REFUSED [C7,#12222].
    { id: 'red-to-board', when: (s, m) => redReturns(s, m) && m.returnToBoard === true, patch: () => ({ status: 'open', owner: null, leaseUntil: null }),
      events: (s, m) => [
        { kind: 'release', by: s.handoff.agentId, detail: { reasonCode: m.boardCodes === true ? 'GATE_REFUSED' : 'OTHER', reason: `the queued gate was refused (${m.result.error.code}); returned to the board for any free seat` } },
        { kind: 'submit_handoff_returned', by: s.handoff.agentId, detail: { commit: s.handoff.commit, returnedToBoard: true } },
        shoutEvent('coordinator', s.handoff.agentId, `Queued submit #${m.id} was refused (${m.result.error.code}); it went back to the board for any free seat. pullboard show ${m.id} prints the refusal.`),
        handoffEvent({ ...s.handoff, state: 'red' })],
      record: (s, m) => ({ ...s.handoff, ...lockWaits(m), state: 'red', error: { ...m.result.error }, completedAt: s.now }) },
    { id: 'red-to-builder', when: (s, m) => redReturns(s, m), patch: (s) => ({ leaseUntil: leaseFrom(s) }),
      events: (s, m) => { const text = String(m.result.error.message ?? '').slice(0, 4000);
        return [
          { kind: 'renew', by: s.handoff.agentId, detail: { leaseUntil: leaseFrom(s), digest: s.handoff.digest, queuedRedReturn: true,
            ...(text.trim() ? { submitOutcome: { code: m.result.error.code, text, digest: s.handoff.digest, pipelineCause: pipelineCause({ code: m.result.error.code, note: text }) } } : {}) } },
          { kind: 'submit_handoff_returned', by: s.handoff.agentId, detail: { commit: s.handoff.commit, leaseUntil: leaseFrom(s) } },
          shoutEvent('coordinator', s.handoff.agentId, `Queued submit #${m.id} was refused (${m.result.error.code}); it stays claimed by you until ${leaseFrom(s)}. Fix it, commit and submit again; pullboard show ${m.id} prints the refusal and its next step.`),
          handoffEvent({ ...s.handoff, state: 'red' })]; },
      record: (s, m) => ({ ...s.handoff, ...lockWaits(m), state: 'red', error: { ...m.result.error }, completedAt: s.now }) },
    // A red whose claim moved on, or an item already submitted (incomplete), only stores the result.
    { id: 'red-unreturned', when: () => true, patch: () => ({}),
      events: (s, m) => [handoffEvent({ ...s.handoff, state: s.item.status === 'submitted' ? 'incomplete' : 'red' })],
      record: (s, m) => ({ ...s.handoff, ...lockWaits(m), state: s.item.status === 'submitted' ? 'incomplete' : 'red', error: { ...m.result.error }, completedAt: s.now }) },
  ],
  followups: [],
});

const leaseFrom = s => new Date(Date.parse(s.now) + s.handoff.leaseMs).toISOString();
const latestSubmit = s => s.submits.filter(e => e.by === s.handoff.agentId).at(-1)?.detail ?? {};
function greenProved(s, m) {
  const sub = s.submits.filter(e => e.by === s.handoff.agentId).at(-1)?.detail;
  const job = s.handoff;
  return Boolean(sub) && sub.commit === m.result.commit && sub.criterionDigest === job.digest && sub.policyCommit === job.main
    && s.receipts.some(r => r.kind === 'submit' && r.commit === job.executionCommit && r.tree === job.executionTree && r.seat === job.agentId && r.frozenDigest === job.digest && r.sourceClean === true);
}

/** The coordinator notices an infrastructure stop writes (recordInfrastructureStop). */
function infrastructureShouts(s, m) {
  const job = s.handoff, error = m.result.error, windowSpent = m.windowSpent === true;
  const exhausted = windowSpent || (job.infrastructureRetries ?? 0) >= INFRASTRUCTURE_RETRY_LIMIT;
  if (job.infrastructureNotified) return [];
  if (exhausted) return [shoutEvent('sentinel', 'coordinator', windowSpent
    ? `Queued gate #${m.id} stopped on infrastructure after the 30-minute runner retry window (${error.code}) at ${String(job.commit).slice(0, 12)}: ${String(error.message ?? '').slice(0, 300)}. Restore the runner and requeue the captured candidate. No builder red.`
    : `Queued gate #${m.id} exhausted ${INFRASTRUCTURE_RETRY_LIMIT} healthy-executor recovery retries (${error.code}) at ${String(job.commit).slice(0, 12)}; restore the runner and requeue the captured candidate. No builder red.`)];
  if (!RECOVERED_STOPS.has(error.code)) return [shoutEvent('sentinel', 'coordinator',
    `Queued gate #${m.id} stopped on the machine (${error.code}): ${error.message} Nothing is wrong with the builder's source and it keeps its claim; requeue the captured candidate once the machine recovers. No builder red.`)];
  return [];
}


  const tables = Object.freeze({ SUBMIT: bind(SUBMIT), COMMIT: bind(COMMIT), OUTCOME: bind(OUTCOME), START: bind(START), COMPLETE: bind(COMPLETE), RECAPTURE: bind(RECAPTURE) });
  return Object.freeze({ rules: defineRules(DEFS), tables });
}
