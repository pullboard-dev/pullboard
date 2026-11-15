/** The landing moves as pure tables: select a candidate, admit a trunk, record a pushed batch, merge, and what a batch's outcome does next, ported from the pure-core pilot [C7,#8249]. */
import { Refused } from '../../../../kernel/light.js';
import { defineRules } from './rules.js';
import { runTable } from './run.js';

/**
 * The next step the landing commands print for each refusal code the landing tables share; the live commands' next-step maps read these.
 * Why: one sentence per code, so the table and the commands can never word the same refusal two ways.
 */
export const LANDING_NEXT = Object.freeze({
  LAND_BATCH: 'adopt the recorded batch: pullboard land --adopt',
  LAND_ITEM_MOVED: 'rebuild the batch from current verified work: pullboard land',
  LAND_NOT_PUSHED: 'push the batch, then pullboard land --adopt',
  LAND_TEST_DEFECT: 'commit a correction to the test named by the held defect, or ask the person for an expiring test waiver; then run pullboard land again',
  FORCED_REASON: 'name why this merge bypassed the gate: pullboard merged <id> <commit> --forced "<why>"',
  NOT_VERIFIED: 'merge only verified items; see pullboard list --all',
  COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
  LAND_LEASE_LOST: 'stop, read pullboard resume, and adopt only after the holder finishes',
  LAND_ADOPT: 'pullboard land --adopt',
  LAND_TRUNK: 'return the checkout to the trunk, then run pullboard land',
  NOT_PENDING: 'nothing to do: only a verified item with no landing receipt lands',
  ITEM_HELD: 'ask the coordinator to lift the hold: pullboard shout coordinator --kind question "lift the hold on #<id>"',
  STALE_VERDICT: 'merge main, resubmit, and verify again',
  LAND_KNOWN_RED: 'fix the failing tests and resubmit, or ask the person for an expiring test waiver',
  LAND_RUNNER_SOURCE_HELD: 'wait for a new head or a new main',
  LAND_REPEATED_RED: 'fix what the landing batches found red, then resubmit',
  WAITS_ON_ITEM: 'land the dependency first: pullboard show <id>',
  STACKED_UNVERIFIED: 'verify the carried submission first',
  PUBLISH_RED_FILE: 'fix the red publish; the item waits until it is green',
  LAND_FILE_OVERLAP: 'it leads the next batch; nothing to do',
});

const ITEM_REFUSALS = Object.freeze(['LAND_HEADER', 'LAND_PLAN_UNPLACED', 'LAND_ENGINE_UNNUMBERED', 'LAND_COMPANION_MISSING', 'LAND_MODULE_PARSE', 'LAND_STATIC_RED', 'RATCHET_ROSE']);
const HOLDING_DEFECT = Object.freeze(['open', 'claimed', 'submitted']);
const RED_ENDS = Object.freeze(['blocked', 'test-defect', 'flaky']);
const LANDED = Object.freeze(['landed', 'trunk', 'pushed']);
const RETRYABLE = Object.freeze(['LAND_DIAGNOSTIC', 'SLOT_DB_LOCKED', 'LAND_GATE_TIMEOUT', 'LAND_RUNNER_FAULT']);

const entriesOf = (batch) => batch?.candidates ?? batch?.items ?? [];

// ---------------------------------------------------------------------------------------------------------------
// Pure folds over the recorded batches (latest revision per id, first-seen order).
// ---------------------------------------------------------------------------------------------------------------

/** True when a refusal names the candidate's own content rather than the landing's machinery. */
export function itemRefusal(code, message = '') {
  if (!code) return false;
  if (ITEM_REFUSALS.includes(code)) return true;
  const text = String(message ?? '');
  return (code === 'LAND_CLI_SMOKE' && /^(?:\[LAND_CLI_SMOKE\] )?the candidate's /u.test(text))
    || (code === 'LAND_MERGE' && /update-docs\.js failed in the merged tree/u.test(text))
    || (code === 'GATE_RED' && /static checks are red/u.test(text))
    || (code === 'LAND_DIRTY' && /placement failed for .*; repair the cells plan/u.test(text));
}

/** A batch's verdict on redness: true landed, false red or item-refused, null says nothing. */
export function batchOutcome(batch) {
  if (batch.dropped || batch.supersededByMain) return null;
  const culprits = Array.isArray(batch.culprits) && batch.culprits.length > 0;
  const testRed = (batch.failures ?? []).some(failure => failure?.file);
  if (batch.state === 'blocked' && !culprits && !testRed && batch.refusal) return itemRefusal(batch.refusal.code, batch.refusal.message) ? false : null;
  if (batch.state === 'blocked' || culprits) return false;
  return LANDED.includes(batch.state) ? true : null;
}

/** When each item last failed, on a rising clock. */
export function failureTurns(batches) {
  const tried = new Map();
  let clock = 0;
  for (const batch of batches) if (batchOutcome(batch) === false) for (const entry of batch.items ?? []) tried.set(entry.id, ++clock);
  return tried;
}

/** Failure turns plus one turn per blocked batch for items it carried at their current commit. */
export function landingTurns(batches, pending) {
  const failed = failureTurns(batches);
  const commits = new Map(pending.map(item => [item.id, item.commit]));
  const turns = new Map(failed);
  let clock = Math.max(0, ...failed.values());
  for (const batch of batches) {
    if (batch.state !== 'blocked' || batch.dropped || batch.supersededByMain) continue;
    clock += 1;
    for (const entry of entriesOf(batch)) if (!failed.has(entry.id) && commits.get(entry.id) === entry.commit) turns.set(entry.id, clock);
  }
  return turns;
}

/** Red batches in a row for one item at one commit, newest first, stopping at a landing. */
export function repeatedReds(batches, item) {
  let reds = 0;
  for (const batch of [...batches].reverse()) {
    if (!entriesOf(batch).some(entry => entry.id === item.id && entry.commit === item.commit)) continue;
    if (batch.dropped || batch.supersededByMain) continue;
    if (LANDED.includes(batch.state)) break;
    if (!RED_ENDS.includes(batch.state)) continue;
    const red = batch.state !== 'blocked' || (batch.failures ?? []).some(failure => failure?.file) || (batch.culprits ?? []).some(entry => entry.id === item.id);
    if (red) reds += 1;
  }
  return reds;
}

const carries = (batch, item, base) => batch.base === base && entriesOf(batch).some(entry => entry.id === item.id && entry.commit === item.commit);
/** RUNNER_SOURCE refusals on this base carrying this exact commit. */
export function runnerSourceRefusals(batches, item, base) {
  return batches.filter(batch => carries(batch, item, base))
    .reduce((sum, batch) => sum + (batch.refusals ?? (batch.refusal ? [batch.refusal] : [])).filter(refusal => refusal?.code === 'RUNNER_SOURCE').length, 0);
}

/** A file waiver names a path with an extension; anything else names a test case. */
const waiverKind = (test) => /^[^\r\n]*\/[^/\r\n]*[^/\s.]\.[A-Za-z0-9]+$/u.test(test) || /^[^\s/]+\.[A-Za-z0-9]+$/u.test(test) ? 'file' : 'name';
/** A live person waiver (or quarantine) covering a failure at the snapshot's `now`. */
export function waived(s, failure) {
  return [...(s.waivers ?? []), ...(s.io?.quarantineWaivers ?? [])].some(w => Date.parse(w.until) > Date.parse(s.now)
    && (w.quarantine ? w.quarantine.file === failure.file && w.quarantine.name === failure.name
      : (w.kind ?? waiverKind(w.test)) === 'file' ? w.test === failure.file : w.test === failure.name));
}

/** The cause an item's two latest blocked batches share, at its exact commit, or null. */
export function repeatedCause(batches, item, faultCodes) {
  const relevant = batches.filter(batch => batch.state === 'blocked' && entriesOf(batch).some(entry => entry.id === item.id && entry.commit === item.commit));
  if (relevant.length < 2) return null;
  const causes = (batch) => {
    const found = [];
    if (batch.refusal?.code && !faultCodes.includes(batch.refusal.code) && batch.refusal.code !== 'RUNNER_SOURCE') found.push({ kind: 'refusal', key: batch.refusal.code });
    for (const culprit of batch.culprits ?? []) if (culprit.id === item.id && culprit.commit === item.commit) {
      for (const test of culprit.tests ?? []) if (test.file && test.name) found.push({ kind: 'case', key: `${test.file}::${test.name}` });
    }
    return found;
  };
  const prior = causes(relevant.at(-2));
  const repeated = causes(relevant.at(-1)).find(cause => prior.some(earlier => earlier.kind === cause.kind && earlier.key === cause.key));
  return repeated ? { ...repeated, base: relevant.at(-1).base, commit: item.commit, batch: relevant.at(-1).id } : null;
}

/** The lease fence still names the live holder. */
const fenceHolds = (s, m) => {
  const h = s.lease?.holder;
  return Boolean(h) && h.token === m.fence?.token && h.generation === m.fence?.generation && h.branch === m.fence?.branch
    && !(h.lineage === null && Date.parse(h.until) <= Date.parse(s.now)) && h.lineage === (s.lineage ?? null);
};

/** The first entry of a recorded batch that no longer matches its item, with why, or undefined. */
const movedEntry = (s) => (s.batch?.items ?? []).map(entry => {
  const item = s.items[entry.id];
  if (item.commit !== entry.commit || item.status !== 'verified') return { id: entry.id, why: 'changed after the batch was gated' };
  if ((entry.reviewedCommit ?? entry.commit) !== item.checked) return { id: entry.id, why: 're-reviewed after the batch was gated' };
  if (item.mergedCommit && item.mergedCommit !== entry.merge) return { id: entry.id, why: 'already has another landing receipt' };
  return null;
}).find(Boolean);

const reasonOf = (m) => (typeof m.forced === 'string' ? m.forced.trim() : '');
const dependencyMet = (dep) => Boolean(dep?.mergedCommit) || dep?.status === 'withdrawn';
const unfinished = (s) => s.batches.findLast(batch => batch.state !== 'landed' && batch.state !== 'blocked');
/** A blocked batch with no culprit, no held item and a retryable refusal is retried once main moves. */
const retryable = (batch, main) => batch.state === 'blocked' && batch.base !== main && !batch.supersededByMain && !batch.dropped
  && !(batch.culprits?.length) && !(batch.blocked ?? []).some(entry => entry.code === 'ITEM_HELD')
  && (RETRYABLE.includes(batch.refusal?.code) || String(batch.refusal?.code ?? '').startsWith('RUNNER_'));

/**
 * The landing rules over injected limits, fault codes and the repeat-hold prefix.
 * Snapshots by move: select `{ now, base, item, items, batches, waivers, unverified, picked: { touched }, collisionFree, io }`;
 * admit `{ now, batches, defects, waivers, io }`; record `{ now, lease, lineage, batch, items }`; merged `{ item }`; outcome `{ batch, batches, perItem, items, waivers, now, io }`.
 * Why: each guard below is one fact, so its refusal, its trace and `pullboard explain` never drift apart.
 */
function landingRules({ limits, faultCodes, repeatHold }) {
  const knownRed = (s) => s.batches.flatMap(batch => batch.culprits ?? []).find(entry => entry.id === s.item.id && entry.commit === s.item.commit && (entry.reviewedCommit ?? entry.commit) === s.item.checked);
  const waitsOn = (s) => s.item.after.filter(id => !dependencyMet(s.items[id]));
  const stackedOn = (s) => (s.io.ownCommits ? s.unverified.find(other => other.id !== s.item.id && s.io.ownCommits.includes(other.commit)) : undefined);
  const publishHit = (s) => (s.io.redFiles ?? []).filter(file => (s.io.changedFiles ?? []).includes(file));
  const overlap = (s) => (s.collisionFree ? (s.io.changedFiles ?? []).filter(file => s.picked.touched[file] !== undefined) : []);
  const holdingDefects = (s) => s.defects.filter(d => d.branch === s.io.trunk?.branch && (d.itemStatus === null || HOLDING_DEFECT.includes(d.itemStatus))
    && !(d.names ?? []).every(name => waived(s, { file: d.test, name })) && !s.io.defectReleased?.[d.test]);
  const accepted = (s) => Boolean(s.io.gate?.isGreen || s.io.gate?.knownMainProof || s.io.gate?.waivedProof);
  const single = (s) => s.perItem && entriesOf(s.batch).length === 1;
  return defineRules({
    // select
    pending: { says: 'the item is verified and has no landing receipt', holds: (s) => s.item.status === 'verified' && !s.item.mergedCommit },
    notHeld: { says: 'the item carries no coordinator hold', holds: (s) => !s.item.holdReason },
    verdictFresh: { says: 'the accepted review still composes unchanged on main [io]', holds: (s) => !s.io.staleVerdict },
    notKnownRed: { says: 'the item is not a culprit at this exact commit, or every failing case is waived', holds: (s) => { const k = knownRed(s); return !k || k.tests.every(t => waived(s, t)); } },
    runnerSourceFree: { says: 'fewer RUNNER_SOURCE refusals on this base than the retry limit', holds: (s) => runnerSourceRefusals(s.batches, s.item, s.base) < limits.runnerSourceRetries },
    notRepeatedRed: { says: 'fewer red batches in a row at this commit than the red limit', holds: (s) => repeatedReds(s.batches, s.item) < limits.redLimit },
    dependenciesLanded: { says: 'every dependency is merged or withdrawn (a verified one is not enough)', holds: (s) => waitsOn(s).length === 0 },
    notStacked: { says: 'the item carries no unverified submission [io: own commits]', holds: (s) => !stackedOn(s) },
    notPublishRed: { says: 'the item touches no file a red publish names [io: files]', holds: (s) => publishHit(s).length === 0 },
    noOverlap: { says: 'with collision-free batches, the item shares no file with one already picked [io: files]', holds: (s) => overlap(s).length === 0 },
    // admit
    trunkKnown: { says: 'the trunk has a tip commit [io]', holds: (s) => Boolean(s.io.trunk?.commit) },
    noTestDefect: { says: 'no open test defect holds this trunk', holds: (s) => holdingDefects(s).length === 0 },
    adoptable: { says: 'an unfinished batch is adopted, never built over, unless it is flaky or a test defect', holds: (s, m) => !unfinished(s) || m.adopt || m.automatic || ['flaky', 'test-defect'].includes(unfinished(s).state) },
    hasInterrupted: { says: 'adopt was asked only when an interrupted batch exists', holds: (s, m) => !m.adopt || Boolean(unfinished(s)) },
    adopting: { says: 'an unfinished batch exists and the move adopts it', holds: (s, m) => Boolean(unfinished(s)) && Boolean(m.adopt || m.automatic) },
    retrying: { says: 'an automatic landing finds a retryable blocked batch from before main moved', holds: (s, m) => Boolean(m.automatic) && Boolean(s.batches.findLast(b => retryable(b, s.io.trunk.commit))) },
    // record
    coordinatorActs: { says: 'the actor is the coordinator', holds: (s, m) => m.actor === 'coordinator' },
    fenceLive: { says: 'a write names the live landing lease holder: token, generation, branch and an unexpired deadline', holds: (s, m) => !(Boolean(m.fence) || Boolean(s.lease?.holder)) || fenceHolds(s, m) },
    batchTip: { says: 'the pushed tip matches the recorded batch', holds: (s, m) => Boolean(s.batch) && s.batch.tip === m.tip },
    batchLanded: { says: 'the batch already recorded its landing', holds: (s) => s.batch.state === 'landed' },
    published: { says: 'receipts follow a recorded push or trunk move', reads: ['batchLanded'], holds: (s, m, fact) => fact('batchLanded') || ['pushed', 'trunk'].includes(s.batch.state) },
    entriesUnchanged: { says: 'every entry is still verified at its gated commit and checked composition, with no other receipt', reads: ['batchLanded'], holds: (s, m, fact) => fact('batchLanded') || !movedEntry(s) },
    // merged
    reasonGiven: { says: 'a forced merge names why it went around the gate', holds: (s, m) => m.forced === undefined || Boolean(reasonOf(m)) },
    mergeable: { says: 'an unforced merge records verified work only', holds: (s, m) => Boolean(reasonOf(m)) || s.item.status === 'verified' },
    forcedUnfinished: { says: 'a forced merge of an item still open, claimed or submitted', holds: (s, m) => Boolean(reasonOf(m)) && ['open', 'claimed', 'submitted'].includes(s.item.status) },
    // outcome
    leaseLost: { says: 'the batch ended on LAND_LEASE_LOST', holds: (s, m) => m.refusal?.code === 'LAND_LEASE_LOST' },
    fault: { says: 'the batch ended on a landing fault, never the item', holds: (s, m) => faultCodes.includes(m.refusal?.code) },
    runnerSourceRefused: { says: 'the batch ended on RUNNER_SOURCE', holds: (s, m) => m.refusal?.code === 'RUNNER_SOURCE' },
    itemRefused: { says: 'a one-item batch ended on a refusal that names the item itself', holds: (s, m) => Boolean(m.refusal) && (single(s) || entriesOf(s.batch).length === 1) && itemRefusal(m.refusal.code, m.refusal.message) },
    refused: { says: 'the batch ended on a refusal', holds: (s, m) => Boolean(m.refusal) },
    culprit: { says: 'the batch named a culprit', holds: (s, m) => Boolean(m.culprit) },
    gateAccepted: { says: 'the exact-tree gate is green, or proven on main, or waived', holds: (s) => accepted(s) },
    oneItem: { says: 'the batch carries one item and lands per item', holds: (s) => single(s) },
  });
}

const reopen = (s) => [{ kind: 'reopen', item: entriesOf(s.batch)[0].id, by: 'coordinator', detail: { landingFailure: true } }];

/** Entries a RUNNER_SOURCE refusal leaves held: a coordinator hold, or retries used up on this base. */
const heldEntries = (s, limits) => entriesOf(s.batch).flatMap(entry => {
  if (s.items[entry.id]?.holdReason) return [{ id: entry.id, code: 'ITEM_HELD' }];
  return runnerSourceRefusals(s.batches, { id: entry.id, commit: entry.commit }, s.batch.base) >= limits.runnerSourceRetries ? [{ id: entry.id, code: 'LAND_RUNNER_SOURCE_HELD' }] : [];
});

/** Items whose two latest blocked batches repeat one cause and are not already held: the automatic parks. */
const toPark = (s, faultCodes) => {
  const asBlocked = s.batches.map(batch => (batch.id === s.batch.id ? { ...batch, state: 'blocked' } : batch));
  return entriesOf(s.batch).map(entry => ({ entry, cause: repeatedCause(asBlocked, { id: entry.id, commit: entry.commit }, faultCodes) }))
    .filter(({ entry, cause }) => cause && s.items[entry.id] && !s.items[entry.id].holdReason && !s.items[entry.id].mergedCommit);
};
const parkEvents = (s, { faultCodes, repeatHold }) => toPark(s, faultCodes).map(({ entry, cause }) => ({ kind: 'hold_item', item: entry.id, by: 'coordinator',
  detail: { reason: `${repeatHold}${JSON.stringify({ kind: cause.kind, key: cause.key, base: cause.base, commit: cause.commit })} landing parked #${entry.id}` } }));

const noPatch = () => ({});

/** The five tables: guards in order, then the outcomes. */
function landingTables(inputs) {
  const { limits } = inputs;
  const guard = (id, requires, code, message, next = LANDING_NEXT[code]) => ({ id, requires, code, message, next });
  const select = Object.freeze({
    name: 'landing-select',
    guards: Object.freeze([
      guard('pending', 'pending', 'NOT_PENDING', (s) => `#${s.item.id} is ${s.item.mergedCommit ? 'already landed' : s.item.status}`),
      guard('not-held', 'notHeld', 'ITEM_HELD', (s) => s.item.holdReason),
      guard('verdict-fresh', 'verdictFresh', 'STALE_VERDICT', (s) => s.io.staleVerdict?.reason ?? 'the accepted review is stale'),
      guard('not-known-red', 'notKnownRed', 'LAND_KNOWN_RED', (s) => `#${s.item.id} is known red at this commit`),
      guard('runner-source-retries', 'runnerSourceFree', 'LAND_RUNNER_SOURCE_HELD', (s) => `#${s.item.id} waits for a new head or a new main`),
      guard('not-repeated-red', 'notRepeatedRed', 'LAND_REPEATED_RED', (s) => `red in its last ${repeatedReds(s.batches, s.item)} landing batches at ${String(s.item.commit).slice(0, 12)}`),
      guard('dependencies-landed', 'dependenciesLanded', 'WAITS_ON_ITEM', (s) => `waits on unmerged item(s) #${s.item.after.filter(id => !dependencyMet(s.items[id])).join(', #')}`),
      guard('not-stacked', 'notStacked', 'STACKED_UNVERIFIED', (s) => `carries #${s.unverified.find(o => o.id !== s.item.id && s.io.ownCommits.includes(o.commit)).id}`),
      guard('not-publish-red', 'notPublishRed', 'PUBLISH_RED_FILE', (s) => `held: its diff touches ${(s.io.redFiles ?? []).filter(f => s.io.changedFiles.includes(f)).join(', ')}, which the red publish names`),
      guard('no-overlap', 'noOverlap', 'LAND_FILE_OVERLAP', (s) => `shares ${s.io.changedFiles.filter(f => s.picked.touched[f] !== undefined).join(', ')}`),
    ]),
    outcomes: Object.freeze([{ id: 'ready', patch: noPatch, events: (s) => {
      const dropped = s.item.after.filter(id => s.items[id]?.status === 'withdrawn' && !s.items[id]?.mergedCommit);
      return [{ kind: 'candidate', item: s.item.id, detail: { id: s.item.id, commit: s.item.commit, ...(s.item.checked !== s.item.commit ? { reviewedCommit: s.item.checked } : {}),
        ...(dropped.length ? { withdrawnDependencies: dropped } : {}) } }];
    } }]),
  });
  const admit = Object.freeze({
    name: 'landing-admit',
    guards: Object.freeze([
      guard('trunk', 'trunkKnown', 'LAND_TRUNK', 'landing runs on the primary branch; this checkout has no trunk'),
      guard('no-test-defect', 'noTestDefect', 'LAND_TEST_DEFECT', 'this trunk is held by an open test defect'),
      guard('adopt-only', 'adoptable', 'LAND_ADOPT', (s) => `batch ${unfinished(s).id} is ${unfinished(s).state}; adopt it, never build over it`),
      guard('adopt-needs-batch', 'hasInterrupted', 'LAND_ADOPT', 'there is no interrupted batch to adopt; run pullboard land', 'run pullboard land'),
    ]),
    outcomes: Object.freeze([
      { id: 'adopt', when: 'adopting', patch: noPatch, events: (s) => [{ kind: 'adopt', detail: { batch: unfinished(s).id } }] },
      { id: 'retry', when: 'retrying', patch: noPatch, events: (s) => [{ kind: 'adopt', detail: { batch: s.batches.findLast(b => retryable(b, s.io.trunk.commit)).id, retry: true } }] },
      { id: 'select', patch: noPatch, events: () => [{ kind: 'select', detail: {} }] },
    ]),
  });
  const record = Object.freeze({
    name: 'landing-record',
    guards: Object.freeze([
      guard('coordinator', 'coordinatorActs', 'COORDINATOR_ONLY', 'only the coordinator finishes a landing'),
      guard('fence', 'fenceLive', 'LAND_LEASE_LOST', 'this command no longer holds the board landing lease; stop its external work, inspect pullboard resume and adopt only after the holder finishes'),
      guard('batch-tip', 'batchTip', 'LAND_BATCH', 'the pushed tip must match its recorded batch; run pullboard land --adopt'),
      guard('published', 'published', 'LAND_NOT_PUSHED', 'record a successful push before landing receipts; run pullboard land --adopt'),
      guard('entries-unchanged', 'entriesUnchanged', 'LAND_ITEM_MOVED', (s) => `item #${movedEntry(s).id} ${movedEntry(s).why}`),
    ]),
    outcomes: Object.freeze([
      { id: 'already-landed', when: 'batchLanded', patch: noPatch, events: () => [] },
      { id: 'land', patch: noPatch, events: (s, m) => [
        ...s.batch.items.filter(entry => !s.items[entry.id].mergedCommit).map(entry => ({ kind: 'merged', item: entry.id, by: m.actor, detail: { commit: entry.merge } })),
        { kind: 'main-moved', item: null, by: m.actor, detail: { sha: m.tip, batch: s.batch.id, items: s.batch.items.map(e => e.id) } }] },
    ]),
  });
  const merged = Object.freeze({
    name: 'landing-merged',
    guards: Object.freeze([
      guard('coordinator', 'coordinatorActs', 'COORDINATOR_ONLY', 'only the coordinator records merges'),
      guard('forced-reason', 'reasonGiven', 'FORCED_REASON', 'a forced merge names why it went around the gate: --forced "<why>"'),
      guard('verified', 'mergeable', 'NOT_VERIFIED', (s) => `item #${s.item.id} is ${s.item.status}; merge verified work only`),
    ]),
    outcomes: Object.freeze([
      { id: 'forced-unfinished', when: 'forcedUnfinished', patch: () => ({ status: 'withdrawn' }), events: (s, m) => [
        { kind: 'withdraw', by: m.actor, detail: { reason: `landed by hand at ${m.commit.slice(0, 12)}: ${reasonOf(m)}` } },
        { kind: 'merged', by: m.actor, detail: { commit: m.commit, forced: true, reason: reasonOf(m), from: s.item.status } }] },
      { id: 'merge', patch: (s, m) => ({ mergedCommit: m.commit }), events: (s, m) => [
        { kind: 'merged', by: m.actor, detail: { commit: m.commit, ...(reasonOf(m) ? { forced: true, reason: reasonOf(m), from: s.item.status } : {}) } }] },
    ]),
  });
  const outcome = Object.freeze({
    name: 'landing-outcome',
    guards: Object.freeze([]),
    outcomes: Object.freeze([
      { id: 'lease-lost', when: 'leaseLost', patch: noPatch, events: () => [] },
      { id: 'fault', when: 'fault', patch: () => ({ state: 'blocked' }), events: () => [] },
      { id: 'runner-source', when: 'runnerSourceRefused', patch: (s) => (heldEntries(s, limits).length ? { state: 'blocked', blocked: heldEntries(s, limits) } : {}), events: (s) => parkEvents(s, inputs) },
      { id: 'item-refused', when: 'itemRefused', patch: () => ({ state: 'blocked' }), events: (s) => reopen(s) },
      { id: 'refused', when: 'refused', patch: () => ({ state: 'blocked' }), events: (s) => parkEvents(s, inputs) },
      { id: 'culprit', when: 'culprit', patch: () => ({ state: 'blocked' }), events: (s) => parkEvents(s, inputs) },
      { id: 'proceed', when: 'gateAccepted', patch: () => ({ state: 'ready' }), events: () => [] },
      { id: 'return-culprit', when: 'oneItem', patch: () => ({ state: 'blocked' }), events: (s) => reopen(s) },
      { id: 'bisect', patch: () => ({ state: 'bisecting' }), events: () => [] },
    ]),
  });
  return { select, admit, record, merged, outcome };
}

/**
 * Build the landing rules and tables over the limits, fault codes and repeat-hold prefix, handed in by the caller.
 * Why: moves may not import the landing cell, and these numbers must stay one source; the wiring passes the landing's own, so there is no second copy to drift.
 *
 * @param {{ limits: { redLimit: number, runnerSourceRetries: number, staleProbes: number }, faultCodes: string[], repeatHold: string }} inputs
 * @returns {{ rules: Readonly<Record<string, object>>, tables: Readonly<Record<'select' | 'admit' | 'record' | 'merged' | 'outcome', object>>, inputs: object }}
 */
export function landingEngine(inputs) {
  const { limits, faultCodes, repeatHold } = inputs ?? {};
  if (![limits?.redLimit, limits?.runnerSourceRetries, limits?.staleProbes].every(Number.isSafeInteger) || !Array.isArray(faultCodes) || typeof repeatHold !== 'string' || !repeatHold) {
    throw new Refused('LANDING_TABLE_INPUTS', 'the landing tables need their limits, fault codes and repeat-hold prefix', 'pass { limits: { redLimit, runnerSourceRetries, staleProbes }, faultCodes, repeatHold } from the landing cell');
  }
  return Object.freeze({ rules: landingRules(inputs), tables: Object.freeze(landingTables(inputs)), inputs: Object.freeze({ ...inputs }) });
}

/** Landing order: failed items behind untried ones (least recently failed first), then pins, then accept order, then id. */
export function landingOrder(s, pending, { blockedTurns = true } = {}) {
  const turns = blockedTurns === false ? failureTurns(s.batches) : landingTurns(s.batches, pending);
  const pins = new Map((s.io.pins ?? []).map((id, index) => [id, index]));
  const cmp = (a, b) => {
    if (turns.has(a.id) || turns.has(b.id)) {
      if (!turns.has(a.id)) return -1;
      if (!turns.has(b.id)) return 1;
      if (turns.get(a.id) !== turns.get(b.id)) return turns.get(a.id) - turns.get(b.id);
    }
    const pa = pins.get(a.id);
    const pb = pins.get(b.id);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      if (pa !== pb) return pa - pb;
    }
    return (s.acceptOrder[a.id] ?? Infinity) - (s.acceptOrder[b.id] ?? Infinity) || a.id - b.id;
  };
  return [...pending].sort(cmp);
}

/**
 * The whole selection: walk the pending items in landing order, run the select table on each until the batch is full,
 * then project up to `staleProbes` unheld items behind it for staleness only. Pure: every io answer comes in `ioFor(id)`.
 *
 * @param {ReturnType<typeof landingEngine>} engine
 * @param {object} s - `{ now, base, items, batches, waivers, unverified, collisionFree, acceptOrder, io }`.
 * @param {number} maximum
 * @param {(id: number) => object} [ioFor]
 * @returns {{ ready: object[], blocked: { id: number, code: string, row?: string }[] }}
 */
export function selectBatch(engine, s, maximum, ioFor = () => ({}), rules = {}) {
  const pending = Object.values(s.items).filter(item => item.status === 'verified' && !item.mergedCommit);
  const ready = [];
  const blocked = [];
  const touched = {};
  let probes = 0;
  for (const item of landingOrder(s, pending, rules)) {
    const io = { ...s.io, ...ioFor(item.id) };
    if (ready.length >= maximum) {
      if (probes >= engine.inputs.limits.staleProbes || item.holdReason) continue;
      probes++;
      if (io.staleVerdict) blocked.push({ id: item.id, code: 'STALE_VERDICT' });
      continue;
    }
    const out = runTable(engine.tables.select, engine.rules, { ...s, item, io, picked: { count: ready.length, touched: { ...touched } } }, { name: 'select', id: item.id });
    if (out.refused) { blocked.push({ id: item.id, code: out.refused.code, row: out.refused.row }); continue; }
    for (const file of s.collisionFree ? io.changedFiles ?? [] : []) touched[file] = item.id;
    ready.push(out.events[0].detail);
  }
  return { ready, blocked };
}
