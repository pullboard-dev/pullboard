/** Coordinator landing selection step; source-preserving partition of land.js [B3,R3,C7]. */
import { localDependencyIds } from './item-dependencies.js';
import { landingChangedFiles } from './land-collisions.js';
import { deferredLandingPriorities } from './land-collisions.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './board.js';
import { tryGit } from './git.js';
import { landingLeaseState } from './landing-lease.js';
import { sameEnvironment } from './execution-environment.js';
import { staleVerdictRefusal } from './verdict-freshness.js';
import { verdictProjector } from './verdict-freshness.js';

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

/** A test defect holds every batch on its trunk until the committed test changes or every failure is waived. */
export function heldTestDefects(root, board, trunk, landingPorts) {
  return store.landingTestDefects(board).filter(defect => {
    if (defect.branch !== trunk.branch) return false;
    const blob = testBlob(root, trunk.commit, defect.test);
    return !(blob && blob !== defect.blob && blob !== defect.trunkBlob) && !defect.names.every(name => store.landingWaiverFor(board, { file: defect.test, name }, landingPorts));
  });
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

/** Select in verdict order; a read-only preflight may stop at its first eligible item [B3,R3]. */
export function candidates(board, root, base, maximum, { firstReady = false, landingPorts } = {}) {
  const all = store.listItems(board, { all: true });
  const projector = verdictProjector(root, board, { main: base }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem });
  const pending = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit);
  const order = new Map();
  for (const event of store.events(board)) if (event.event_kind === 'accept') order.set(event.item_id, event.event_id);
  const collisionFree = store.lineSettings(board).collisionFreeBatch === true;
  const batches = store.landingBatches(board);
  const priorities = collisionFree ? deferredLandingPriorities(batches, pending) : new Map();
  pending.sort((left, right) => {
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
  for (const original of pending) {
    const item = { ...original, item_landing_commit: store.checkedLandingCommit(board, original) };
    const stale = projector.state(item);
    if (stale) { blocked.push({ id: item.item_id, ...stale }); continue; }
    const known = knownReds.find((entry) => entry.id === item.item_id && entry.commit === item.item_commit
      && (entry.reviewedCommit ?? entry.commit) === item.item_landing_commit);
    if (known && !known.tests.every((failure) => store.landingWaiverFor(board, failure, landingPorts))) {
      blocked.push({ id: item.item_id, code: 'LAND_KNOWN_RED', tests: known.tests });
      continue;
    }
    const dependencies = localDependencyIds(item);
    if (dependencies.some((id) => !all.find((other) => other.item_id === id)?.item_merged_commit && !ready.some((other) => other.item_id === id))) continue;
    const stacked = store.unverifiedSubmissions(board).find((other) => other.item_id !== item.item_id
      && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, item.item_landing_commit]).status === 0
      && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, base]).status !== 0);
    if (stacked) {
      blocked.push({ id: item.item_id, code: 'STACKED_UNVERIFIED', stacked: stacked.item_id });
      continue;
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
  for (const entry of selected.blocked) say(`${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}`);
  return { batch: null, landed: [], conflicts: [], blocked: selected.blocked, culprits: [], flakes: [] };
}
