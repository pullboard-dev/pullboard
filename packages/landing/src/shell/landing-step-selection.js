import { landingWaiverFor as nativeLandingWaiverFor } from '../core/landing-waivers.js';
/** Coordinator landing selection step; source-preserving partition of land.js [B3,R3,C7]. */
import { localDependencyIds } from '../../../items/index.js';
import { landingChangedFiles } from '../core/land-collisions.js';
import { publishRedTouched } from './publish-pause.js';
import { runnerSourceHold } from '../core/runner-source-hold.js';
import { deferredLandingPriorities } from '../core/land-collisions.js';
import { landingBatchSize } from '../core/landing-batch-size.js';
import { roundFailures } from '../core/landing-batch-size.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../src/board.js';
import { tryGit } from '../../../../src/git.js';
import { landingLeaseState } from '../../../../src/board-landing-lease.js';
import { sameEnvironment } from '../../../sandbox/index.js';
import { staleVerdictRefusal } from '../../../verify/index.js';
import { verdictProjector } from '../../../verify/index.js';
import { cachedMainComparison } from './main-red.js';
import { compareMainFailures } from './main-red.js';
import { cachedFailureSignatures } from './main-failure-matches.js';

/** Hash a test's current bytes, so a real correction can unblock its held batch. */
export function testHash(root, file) {
  try { return createHash('sha256').update(readFileSync(join(root, file))).digest('hex'); }
  catch { return null; }
}

/** Read a committed test identity; an uncommitted edit cannot release a trunk hold. */
export function testBlob(root, commit, file) {
  const result = tryGit(root, ['rev-parse', '--verify', `${commit}:${file}`]);
  return result.status === 0 ? result.stdout : null;
}

/**
 * True when the newest recorded run of the defect's test file at the trunk commit shows every recorded failing case
 * passing: a green file, or a red one whose named failures include none of the defect's cases. No recorded run, or one
 * whose failures are not named, never releases. Why: fixing the code and leaving the test as it was kept the trunk held [C7].
 */
export function defectPassedAtTrunk(root, trunk, defect, comparison = cachedMainComparison) {
  if (!Array.isArray(defect.names) || !defect.names.length) return false;
  let entry;
  try { entry = comparison(root, trunk.commit, [defect.test]).files?.find(row => row.file === defect.test); } catch { return false; }
  if (!entry) return false;
  if (entry.result === 'green') return true;
  const failures = entry.result === 'red' ? cachedFailureSignatures(entry, defect.test) : undefined;
  return Array.isArray(failures) && failures.length > 0 && !failures.some(row => defect.names.includes(row.name));
}

/** The repair item statuses under which a test defect still holds its trunk: its repair is still outstanding [C7]. */
export const HOLDING_DEFECT_STATUSES = Object.freeze(new Set(['open', 'claimed', 'submitted']));

/**
 * The live board status of a test defect's repair item, or null when the board has no such item here.
 * Why: a defect is recorded once and kept until its cases pass, so a hold read without its item's live status kept the
 * trunk held by withdrawn #3304 and left accepted items for the coordinator to land by hand on 8 Nov (#3761).
 */
export function defectItemStatus(board, defect, getItem = store.getItem) {
  if (!Number.isSafeInteger(defect?.item)) return null;
  try { return getItem(board, defect.item)?.item_status ?? null; } catch { return null; }
}

/**
 * Whether a test defect still holds its trunk, read live from the board on every call: its repair item is open, claimed
 * or submitted. A withdrawn, accepted or landed item holds nothing. A defect whose item this board cannot read keeps
 * its hold, so an unreadable record never lands work past a real red.
 */
export function defectStillHolds(board, defect, getItem = store.getItem) {
  const status = defectItemStatus(board, defect, getItem);
  return status === null || HOLDING_DEFECT_STATUSES.has(status);
}

/**
 * A test defect holds every batch on its trunk while its repair item is open, claimed or submitted, until the committed
 * test changes, every failure is waived, or its cases pass at the trunk tip. Each held defect carries its item's live
 * `status`, so the refusal names it [C7].
 */
export function heldTestDefects(root, board, trunk, landingPorts, { defects = store.landingTestDefects, comparison = cachedMainComparison, getItem = store.getItem } = {}) {
  return defects(board).flatMap(defect => {
    if (defect.branch !== trunk.branch) return [];
    if (!defectStillHolds(board, defect, getItem)) return [];
    const status = defectItemStatus(board, defect, getItem);
    const blob = testBlob(root, trunk.commit, defect.test);
    const holds = !(blob && blob !== defect.blob && blob !== defect.trunkBlob) && !defect.names.every(name => nativeLandingWaiverFor(board, { file: defect.test, name }, landingPorts))
      && !defectPassedAtTrunk(root, trunk, defect, comparison);
    return holds ? [{ ...defect, status: status ?? undefined }] : [];
  });
}

/** The LAND_TEST_DEFECT refusal text for the defects holding a trunk, naming each repair item and its live status [C7]. */
export function testDefectHoldMessage(held) {
  return `this trunk is held by ${held.map(defect => `#${defect.item ?? '?'} (${defect.status ?? 'status unreadable'}; ${defect.test})`).join(', ')}; correct the committed test or ask an approver for an expiring waiver`;
}

/**
 * Close each defect on this trunk whose recorded failing cases pass in a recorded run at the trunk commit, one
 * closeLandingTestDefect move each, so landings at later trunk commits are not held by it again [C7].
 * Why: heldTestDefects releases on a run at the current tip only, and every landing moves the tip, so the automatic
 * lander refused #3304 LAND_TEST_DEFECT again one landing after its test was recorded green (#3694).
 */
export async function closePassedTestDefects({ root, board, trunk, write, say = () => {}, onWait }, { defects = store.landingTestDefects, comparison = cachedMainComparison, measure = compareMainFailures } = {}) {
  const closed = [];
  for (const defect of defects(board)) {
    if (defect.branch !== trunk.branch || !Number.isSafeInteger(defect.item)) continue;
    // A defect whose repair item was withdrawn or landed holds nothing, so its test is not run for it (#3761).
    if (!defectStillHolds(board, defect)) continue;
    if (!defectPassedAtTrunk(root, trunk, defect, comparison)) {
      await measureHeldTest(root, trunk, defect, onWait, measure);
      if (!defectPassedAtTrunk(root, trunk, defect, comparison)) continue;
    }
    const result = await write('closeLandingTestDefect', [{ agentId: 'coordinator', branch: defect.branch, test: defect.test, item: defect.item, commit: trunk.commit }]);
    if (result) {
      closed.push(result);
      say(`landing closes test defect #${defect.item} (${defect.test}): its cases passed at ${trunk.commit.slice(0, 10)}`);
    }
  }
  return closed;
}

/** Held files this process already ran at a trunk commit, so a file still red there runs once per commit, not once per wake. */
const measuredHeld = new Set();

/**
 * Run a defect's held file at the trunk commit when the main comparison cache has no entry for it, and let the cache
 * keep the result. Why: nothing else wrote that entry, so a hold whose test was green kept every accepted batch
 * refused LAND_TEST_DEFECT for 30 minutes on 8 Nov until the coordinator landed by hand (#3719). The run goes through
 * compareMainFailures, so it uses a runner when one is registered and this machine otherwise. A failed run records nothing and the hold stays.
 */
async function measureHeldTest(root, trunk, defect, onWait, measure) {
  if (!Array.isArray(defect.names) || !defect.names.length) return;
  const key = `${root}\0${trunk.commit}\0${defect.test}`;
  if (measuredHeld.has(key)) return;
  measuredHeld.add(key);
  try { await measure(root, { tests: [{ file: defect.test, passed: false }] }, onWait, '', { commit: trunk.commit, detailed: true }); }
  catch { /* No measurement leaves the hold as it was. */ }
}

/** Keep each verdict's recorded executor distinct from the actual landing host. */
export function environmentWarnings(board, items, environment) {
  return items.flatMap(entry => {
    const verdict = store.acceptedVerdict(board, store.getItem(board, entry.id));
    const recorded = verdict?.environment ?? null;
    return sameEnvironment(recorded, environment) ? [] : [{ item: entry.id, recorded, landing: environment }];
  });
}

/** Keep the submitted identity and, when different, its sealed checked composition. */
export function landingEntry(item) {
  return { id: item.item_id, commit: item.item_commit,
    ...(item.item_landing_commit !== item.item_commit ? { reviewedCommit: item.item_landing_commit } : {}) };
}

/**
 * Whether a dependency no longer holds an item back: merged, or withdrawn [C7].
 * Why: a withdrawn item never merges, so counting it unmerged left #2822 accepted for 34 h, re-blocked every minute.
 */
export function dependencySatisfied(dependency) {
  return Boolean(dependency?.item_merged_commit) || dependency?.item_status === 'withdrawn';
}

/** Select in verdict order; a read-only preflight may stop at its first eligible item [B3,R3]. */
export function candidates(board, root, base, maximum, { firstReady = false, landingPorts, listItems = store.listItems, first = [], redFiles = [] } = {}) {
  // landing.first in accepted trunk policy: these items go ahead of the accept order, in the order listed [C7].
  const pinned = new Map(first.map((id, index) => [id, index]));
  const all = listItems(board, { all: true });
  const projector = verdictProjector(root, board, { main: base }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem });
  const pending = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit);
  const order = new Map();
  for (const event of store.events(board)) if (event.event_kind === 'accept') order.set(event.item_id, event.event_id);
  const collisionFree = store.lineSettings(board).collisionFreeBatch === true;
  const batches = store.landingBatches(board);
  const priorities = collisionFree ? deferredLandingPriorities(batches, pending) : new Map();
  // A failed item goes behind every untried item, least recently failed first, so red items a small adaptive cap keeps
  // picking take turns and cannot starve the queue (#2911).
  const failed = roundFailures(batches);
  pending.sort((left, right) => {
    if (failed.has(left.item_id) || failed.has(right.item_id)) {
      if (!failed.has(left.item_id)) return -1;
      if (!failed.has(right.item_id)) return 1;
      if (failed.get(left.item_id) !== failed.get(right.item_id)) return failed.get(left.item_id) - failed.get(right.item_id);
    }
    const leftPin = pinned.get(left.item_id), rightPin = pinned.get(right.item_id);
    if (leftPin !== undefined || rightPin !== undefined) {
      if (leftPin === undefined) return 1;
      if (rightPin === undefined) return -1;
      if (leftPin !== rightPin) return leftPin - rightPin;
    }
    const leftPriority = priorities.get(left.item_id);
    const rightPriority = priorities.get(right.item_id);
    if (leftPriority !== undefined || rightPriority !== undefined) {
      if (leftPriority === undefined) return 1;
      if (rightPriority === undefined) return -1;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    }
    return (order.get(left.item_id) ?? Infinity) - (order.get(right.item_id) ?? Infinity) || left.item_id - right.item_id;
  });
  const ready = [];
  const blocked = [];
  const touched = new Map();
  const knownReds = batches.flatMap((batch) => batch.culprits ?? []);
  // Unverified submissions not already on base, read once: a pending item stacks on one when that submission's commit
  // is among the item's own commits past base. Why: two merge-base walks per pending item per submission (850 Git
  // processes for 85 waiting items) cost 4 minutes of every selection and left the lander idle between batches.
  const unverified = store.unverifiedSubmissions(board).filter((other) => tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, base]).status !== 0);
  let staleProbes = 0;
  for (const original of pending) {
    // A full batch stops the walk: each later item cost a verdict projection and two git calls per unverified
    // submission, so choosing 2 of 85 accepted items took 15 minutes before any test ran [C7]. A few items behind
    // the batch still get their verdict projected, so a stale one returns to its lane this wake instead of waiting
    // behind every fresh accept: #2466, #2711 and #2988 sat 30 h that way on 5 Nov [B3,C7].
    if (ready.length >= maximum) {
      if (staleProbes >= 8 || original.item_hold_at) continue;
      staleProbes++;
      const behind = projector.state({ ...original, item_landing_commit: store.checkedLandingCommit(board, original) });
      if (behind?.code === 'STALE_VERDICT') blocked.push({ id: original.item_id, ...behind });
      continue;
    }
    // A held verified item keeps its accept but joins no batch until the hold is lifted.
    if (original.item_hold_at) { blocked.push({ id: original.item_id, code: 'ITEM_HELD', message: original.item_hold_reason ?? 'held' }); continue; }
    const item = { ...original, item_landing_commit: store.checkedLandingCommit(board, original) };
    const stale = projector.state(item);
    if (stale) { blocked.push({ id: item.item_id, ...stale }); continue; }
    const known = knownReds.find((entry) => entry.id === item.item_id && entry.commit === item.item_commit
      && (entry.reviewedCommit ?? entry.commit) === item.item_landing_commit);
    if (known && !known.tests.every((failure) => nativeLandingWaiverFor(board, failure, landingPorts))) {
      blocked.push({ id: item.item_id, code: 'LAND_KNOWN_RED', tests: known.tests });
      continue;
    }
    const retried = runnerSourceHold(batches, item, base);
    if (retried) { blocked.push({ id: item.item_id, ...retried }); continue; }
    const dependencies = localDependencyIds(item);
    const waitsOn = dependencies.filter((id) => !dependencySatisfied(all.find((other) => other.item_id === id))); // only merged or withdrawn count as met, even a verified dependency already in this batch [C7]
    // Named, never silent: #3175 waited on a hand-landed, held #3154 for hours with no record of why [C7].
    if (waitsOn.length) { blocked.push({ id: item.item_id, code: 'WAITS_ON_ITEM', message: `waits on unmerged item(s) #${waitsOn.join(', #')}`, items: waitsOn }); continue; }
    const own = unverified.length ? new Set(tryGit(root, ['rev-list', item.item_landing_commit, `^${base}`]).stdout.split('\n')) : new Set();
    const stacked = unverified.find((other) => other.item_id !== item.item_id && own.has(other.item_commit));
    if (stacked) {
      blocked.push({ id: item.item_id, code: 'STACKED_UNVERIFIED', stacked: stacked.item_id });
      continue;
    }
    if (redFiles.length) {
      // A red publish holds only the item whose diff touches a file the red names; the rest still land [C7].
      const hit = publishRedTouched(redFiles, landingChangedFiles(root, base, item.item_landing_commit));
      if (hit.length) {
        blocked.push({ id: item.item_id, code: 'PUBLISH_RED_FILE', files: hit, message: `held: its diff touches ${hit.join(', ')}, which the red publish names` });
        continue;
      }
    }
    if (ready.length < maximum) {
      const files = collisionFree ? landingChangedFiles(root, base, item.item_landing_commit) : [];
      const shared = files.filter(file => touched.has(file));
      if (shared.length) {
        blocked.push({ id: item.item_id, code: 'LAND_FILE_OVERLAP', files: shared,
          commit: item.item_commit, frozenDigest: item.item_frozen_digest,
          with: [...new Set(shared.map(file => touched.get(file)))] });
        continue; // Verdict order is unchanged; this item leads the next eligible batch.
      }
      for (const file of files) touched.set(file, item.item_id);
      ready.push(item);
      if (firstReady) break;
    }
  }
  return { ready, blocked };
}

/**
 * Whether landing goes one verified item at a time: on unless landing.perItem is false or parallel landing is chosen [C7,#2901].
 * Why default on: the batch path never landed an item on the real board, while one merge, one plan and one record per item did.
 */
export function landsPerItem(config) {
  return config?.landing?.perItem !== false && config?.landing?.parallel !== true;
}

/** With per-item landing, a landing takes one verified item; otherwise the caller's limit stands [C7,#2901]. */
export function perItemMaximum(config, maximum = Infinity) {
  return landsPerItem(config) ? 1 : maximum ?? Infinity;
}

/**
 * The most items one landing batch takes: one per item when landing per item. Otherwise a set line.landingBatchSize
 * applies to every real landing, and automatic landing also sizes from the recorded batches; a limit the caller gave
 * still holds. A hand landing with no setting keeps taking every waiting item [C7,H24].
 */
export function landingMaximum(board, config, maximum = Infinity, automatic = false) {
  if (landsPerItem(config)) return 1;
  const override = store.lineSettings(board).landingBatchSize;
  if (typeof override !== 'number' && !automatic) return maximum ?? Infinity;
  return Math.min(maximum ?? Infinity, landingBatchSize(automatic ? store.landingBatches(board) : [], override));
}

/**
 * Whether this landing batch is one per-item landing: a red, conflict or refusal is then that item's alone, so it goes
 * back to open with the evidence instead of a bisection, a main comparison or a trunk hold [C7,#2901].
 */
export function singleItemLanding(state) {
  return landsPerItem(state.config) && (state.batch?.items ?? state.batch?.candidates ?? []).length === 1;
}

/**
 * True when the batch holds exactly one item, whatever the trunk policy. A refusal of that item's own content (a red
 * static check, a CLI smoke naming it) is the item's to fix, so it returns to its builder instead of being adopted
 * again every wake. Why: with per-item off and a batch size of 1, #2566 was retried seven times in 20 minutes on
 * 6 Nov and starved 24 other accepted items [C7,#2901,#2967].
 */
export function oneItemBatch(state) {
  return (state.batch?.items ?? state.batch?.candidates ?? []).length === 1;
}

/** Git arguments that turn off repository hooks for a per-item landing's own merge and amend commits [C7,#2901]. */
export function landingHooks(config) {
  // Every landing commit is the board's own: the items' hooks ran when they were built, and a batch merge that ran the
  // repository's commit-msg hook was refused for lacking a seat's claim (LAND_MERGE on #2721, 44 lander-minutes) [C7].
  return ['-c', 'core.hooksPath=/dev/null'];
}

/** Skip admission only when no queued owner, interrupted batch or recorded Git repair needs it. */
export function idleLanding(board, trunk) {
  const lease = landingLeaseState(board);
  if (lease.holder || lease.line.length) return false;
  return !store.landingBatches(board).some(batch =>
    (batch.state !== 'landed' && batch.state !== 'blocked')
      || (batch.state === 'landed' && batch.base === trunk));
}

/** Preserve the existing empty selection's refusal, blocked reports and result shape. */
export function emptyLanding(selected, say) {
  const stale = selected.blocked.find(item => item.code === 'STALE_VERDICT');
  if (stale) throw staleVerdictRefusal({ item_id: stale.id }, stale);
  for (const entry of selected.blocked) say(`${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}${entry.message ? `: ${entry.message}` : ''}`);
  return { batch: null, landed: [], conflicts: [], blocked: selected.blocked, culprits: [], flakes: [] };
}
