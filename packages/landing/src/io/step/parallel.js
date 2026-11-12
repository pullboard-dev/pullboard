/** Coordinator landing parallel step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from '../completion.js';
import { localDependencyIds } from '../../../../items/index.js';
import { requireOutsideOwner } from '../../../../items/index.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from '../../../../store/index.js';
import { git } from '../../../../git/index.js';
import { isClean } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { untracked } from '../../../../git/index.js';
import { runLandingCandidateWorker } from '../candidates.js';
import { Refused } from '../../../../kernel/index.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { validateLandingRevision } from '../../../../items/index.js';
import { save } from './merge.js';
import { coveredFailures } from './failures.js';
import { liveWaiverProjection } from './failures.js';
import { waivedProof } from './failures.js';
import { bisect } from './diagnose.js';
import { returnCulprits } from './diagnose.js';
import { returnCulprit } from './diagnose.js';
import { judgeRed } from './judge.js';
import { publish } from './publish.js';
import { landsOnTrunk } from './publish.js';
import { inlineDeferredGuards } from './trunk.js';
import { landOnTrunk } from './trunk.js';

/** Read a completed speculative result from its immutable raw log, without another execution. */
function savedCandidateResult(state, candidate) {
  if (!candidate.complete) return null;
  // A prefix whose merge or docs step refused is a red prefix with no gate, never a refusal replayed on every adoption:
  // rethrowing it ended each adopting worker and left the batch "gating" for good [C7].
  if (candidate.error) return { batch: candidate.snapshot, gate: null, error: candidate.error };
  const gate = candidate.gate;
  if (gate?.blockingVerdict) {
    try { state.landingPorts.validateQuarantineGate(state.board, gate); } catch { return null; }
  }
  return { batch: candidate.snapshot, gate: gate ? { ...gate, output: readFileSync(gate.logPath, 'utf8') } : null };
}

/** Keep only small replayable gate metadata; the complete output remains in its immutable log. */
function candidateGateRecord(gate) {
  if (!gate) return null;
  const { tree, isGreen, failures, accounted, complete, requiresGreen, logPath, flakeDiagnostics, timedOut, proofRoot, proofCommit, affectedGate, blockingVerdict, exitCode, quarantineFailures, receiptId, proofReceiptId, collectionReport } = gate;
  return { tree, isGreen, failures, accounted, complete, requiresGreen, logPath, affectedGate,
    // The planned and completed files let a file-waived red be read as waived after adoption (waivedFileProof) [C7].
    ...(collectionReport ? { collectionReport: { plannedFiles: collectionReport.plannedFiles, completedFiles: collectionReport.completedFiles } } : {}),
    ...(blockingVerdict ? { blockingVerdict, exitCode, quarantineFailures, receiptId, proofReceiptId } : {}),
    ...(proofRoot ? { proofRoot, proofCommit } : {}),
    ...(flakeDiagnostics ? { flakeDiagnostics } : {}), ...(timedOut ? { timedOut } : {}) };
}

/** Run all prefixes through normal admission, serializing their delta receipts under one batch. */
async function parallelPrefixes(state, entries) {
  let serial = Promise.resolve();
  const claims = new Map();
  /** A failed delta must not prevent other already-running children from sealing their receipts. */
  const ordered = action => {
    const pending = serial.then(action);
    serial = pending.catch(() => {});
    return pending;
  };
  const counts = state.landingPorts.badgeCounts(state.board);
  const groups = entries.map((_, index) => entries.slice(0, index + 1));
  const descriptors = groups.map(group => {
    const key = createHash('sha256').update(JSON.stringify(['affected-gate-v1', state.batch.base, group, counts, liveWaiverProjection(state.board, state.landingPorts)])).digest('hex');
    const previous = state.batch.parallelCandidates?.find(candidate => candidate.key === key);
    if (previous) {
      if (previous.gate) state.gates.set(previous.gate.tree, previous.gate);
      return previous;
    }
    const directory = join(dirname(state.batch.root), 'candidates', key);
    return { key, snapshot: { version: 1, id: randomUUID(), base: state.batch.base, tip: state.batch.base,
      branch: state.batch.branch, root: join(directory, 'worktree'), items: group, candidates: group,
      conflicts: [], blocked: [], state: 'merging', owner: state.batch.owner,
      logPath: join(directory, 'logs', 'candidate.log'), revision: 0 } };
  });
  await save(state, { state: 'gating', parallelCandidates: [...(state.batch.parallelCandidates ?? []),
    ...descriptors.filter(candidate => !state.batch.parallelCandidates?.some(previous => previous.key === candidate.key))] });
  /** Replace only this child's descriptor; every sibling and the parent's evidence stay current. */
  const update = (key, patch) => ordered(async () => {
    const latest = state.batch.parallelCandidates.find(candidate => candidate.key === key);
    const updated = { ...latest, ...patch };
    await save(state, { parallelCandidates: state.batch.parallelCandidates.map(candidate => candidate.key === key ? updated : candidate) });
    return updated;
  });
  const settled = await Promise.allSettled(descriptors.map(async descriptor => {
    const previous = savedCandidateResult(state, descriptor);
    if (previous) return previous;
    const key = descriptor.key;
    /** Virtual child batches append deltas to their one canonical parent, never overwrite it. */
    const write = async (operation, args) => {
      if (operation === 'claimGate') {
        const [tree, affectedGate] = args;
        const recorded = state.gates.get(tree);
        if (recorded?.timedOut) throw new Refused('LAND_GATE_TIMEOUT', 'this exact tree has a recorded landing timeout; inspect its log before starting a new batch');
        let cached = recorded?.affectedGate === affectedGate ? recorded : null;
        if (cached?.blockingVerdict) {
          try { state.landingPorts.validateQuarantineGate(state.board, cached); } catch { cached = null; }
        }
        if (cached && (completeGate(cached) || !coveredFailures(state, cached))) return { cached };
        const prior = claims.get(tree);
        if (prior) return { cached: await prior.promise };
        let resolveGate;
        let rejectGate;
        const promise = new Promise((resolveResult, rejectResult) => { resolveGate = resolveResult; rejectGate = rejectResult; });
        void promise.catch(() => {});
        claims.set(tree, { key, promise, resolveGate, rejectGate });
        return { owner: true, ...(cached ? { previous: cached } : {}) };
      }
      if (operation === 'finishGate') {
        const [tree, gate] = args;
        const claim = claims.get(tree);
        if (!claim || claim.key !== key || gate.tree !== tree) throw new Refused('LAND_CANDIDATE', 'a candidate returned another tree’s gate; inspect its checkpoint');
        state.gates.set(tree, gate);
        claim.resolveGate(gate);
        return null;
      }
      if (operation !== 'recordLandingBatch') return await state.write(operation, args);
      return await ordered(async () => {
        const { batch, revision } = args[0];
        const latest = state.batch.parallelCandidates.find(candidate => candidate.key === key);
        const before = latest.snapshot;
        validateLandingBatch(batch, revision);
        validateLandingRevision(before, batch, revision);
        const snapshot = { ...batch, revision: revision + 1 };
        const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
        const childEvidence = snapshot.invariantEvidence ?? { gates: [], diagnostics: [] };
        const oldEvidence = before.invariantEvidence ?? { gates: [], diagnostics: [] };
        for (const kind of ['gates', 'diagnostics']) {
          if (JSON.stringify(childEvidence[kind].slice(0, oldEvidence[kind].length)) !== JSON.stringify(oldEvidence[kind])) {
            throw new Refused('LAND_EVIDENCE', 'candidate evidence is append-only; inspect the saved prefix before adopting');
          }
        }
        await save(state, { parallelCandidates: state.batch.parallelCandidates.map(candidate => candidate.key === key ? { ...candidate, snapshot } : candidate),
          invariantEvidence: { ...evidence,
            gates: [...evidence.gates, ...childEvidence.gates.slice(oldEvidence.gates.length)],
            diagnostics: [...evidence.diagnostics, ...childEvidence.diagnostics.slice(oldEvidence.diagnostics.length)] } });
        return snapshot;
      });
    };
    try {
      const result = await runLandingCandidateWorker({ root: state.root, config: state.config, batch: descriptor.snapshot,
        entries: descriptor.snapshot.candidates, fence: state.fence }, {
        write, checkLease: state.checkLease, say: state.say, onWait: state.onWait, workerFile: state.candidateWorkerFile,
        onStart: pid => update(key, { workerPid: pid }),
      });
      await update(key, { complete: true, gate: candidateGateRecord(result.gate) });
      return result;
    } catch (error) {
      for (const claim of claims.values()) if (claim.key === key) claim.rejectGate(error);
      await update(key, { complete: true, error: { code: error.code ?? 'LAND_CANDIDATE', message: error.message } });
      throw error;
    }
  }));
  await serial;
  // All siblings have ended before authority returns to a physical merge or publication.
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map(result => result.value);
}

/** Move the parent's fixed worktree to an already tested composition without rebuilding its tree. */
async function promoteCandidate(state, candidate) {
  await state.checkLease();
  state.checkLeaseNow();
  if (!isClean(state.batch.root) || untracked(state.batch.root).length) throw new Refused('LAND_DIRTY', 'the landing worktree changed; inspect it before adopting');
  git(state.batch.root, ['checkout', '--detach', candidate.batch.tip]);
  await save(state, { tip: candidate.batch.tip, items: candidate.batch.items,
    conflicts: candidate.batch.conflicts ?? [], resolutions: candidate.batch.resolutions ?? [], doctrineCounts: candidate.batch.doctrineCounts ?? [] });
}

/** Exclude a returned candidate and explicit or Git-stacked dependents from later speculation. */
function withoutParallelBlocker(state, entries, removed) {
  const blocked = new Set([removed.id]);
  return entries.filter(entry => {
    if (blocked.has(entry.id)) return false;
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    const dependency = localDependencyIds(item).find(id => blocked.has(id));
    const stacked = tryGit(state.root, ['merge-base', '--is-ancestor', removed.reviewedCommit ?? removed.commit, entry.reviewedCommit ?? entry.commit]).status === 0;
    if (dependency || stacked) {
      blocked.add(entry.id);
      state.batch.blocked = [...state.batch.blocked, { id: entry.id, code: 'STACKED_UNVERIFIED', stacked: dependency ?? removed.id }];
      return false;
    }
    return true;
  });
}

/** Trust a recorded positive main comparison only for every exact failing target of this gate. */
function parallelGreenBase(state, gate) {
  const ids = new Set((gate.flakeDiagnostics?.observations ?? []).filter(row => row.recorded).map(row => row.id));
  const observations = state.landingPorts.flakeLedger(state.board).flatMap(row => row.observations).filter(row => ids.has(row.id));
  return gate.failures.length > 0 && gate.failures.every(failure => observations.some(observation => observation.file === failure.file
    && observation.name === failure.name && observation.main === state.batch.base
    && observation.classification === 'possible-regression' && observation.mainReceipt?.green === true));
}

/**
 * The index of the last prefix proven green: green, waived, or judged red-free (main's cases charged, flakes
 * quarantined after one green rerun). A judged prefix carries its proof; one left red carries its twice-red cases.
 * Why: a red that main shares or that passes its rerun never becomes a trunk-holding test defect [C7,#5838,#5862].
 */
export async function provenThrough(state, results, { judge = judgeRed, promote = promoteCandidate } = {}) {
  let green = results.findLastIndex(result => result.gate?.isGreen || result.gate && waivedProof(state, result.gate));
  while (green < results.length - 1 && results[green + 1].gate) {
    // The rerun reads the batch worktree, so it must hold the judged composition first.
    await promote(state, results[green + 1]);
    const judged = await judge(state, results[green + 1].gate);
    if (!judged?.gate) {
      if (judged) results[green + 1] = { ...results[green + 1], red: judged.red };
      break;
    }
    state.gates.set(judged.gate.tree, judged.gate);
    results[green + 1] = { ...results[green + 1], gate: judged.gate };
    green += 1;
  }
  return green;
}

/** Test prefixes together, remove only diagnosed blockers, and publish one exact green composition. */
export async function parallelLanding(state, initialItems) {
  let remaining = initialItems;
  // A death between returning B and saving survivors must never resurrect a C stacked on B.
  const originals = state.batch.candidates ?? initialItems;
  for (const id of new Set([...state.culprits.map(entry => entry.id), ...(state.batch.conflicts ?? []).map(entry => entry.id)])) {
    const removed = originals.find(entry => entry.id === id);
    if (removed) remaining = withoutParallelBlocker(state, remaining, removed);
  }
  const excluded = new Set((state.batch.blocked ?? []).map(entry => entry.id));
  remaining = remaining.filter(entry => !excluded.has(entry.id));
  // Restore every sealed tree, even when changed badge counts produce a new descriptor key.
  for (const candidate of state.batch.parallelCandidates ?? []) {
    for (const gate of candidate.snapshot.gateResults ?? []) {
      if (!state.gates.has(gate.tree)) state.gates.set(gate.tree, { ...gate, proofRoot: candidate.snapshot.root,
        proofCommit: candidate.snapshot.invariantEvidence?.gates.findLast(entry => entry.isGreen)?.commit });
    }
    if (candidate.gate) state.gates.set(candidate.gate.tree, candidate.gate);
  }
  await save(state, { parallelRemaining: remaining });
  while (remaining.length) {
    const results = await parallelPrefixes(state, remaining);
    const conflicts = results.flatMap(result => result.batch.conflicts ?? []);
    if (conflicts.length) {
      const blocker = remaining.find(entry => conflicts.some(conflict => conflict.id === entry.id));
      await save(state, { conflicts });
      remaining = withoutParallelBlocker(state, remaining, blocker);
      await save(state, { parallelRemaining: remaining });
      continue;
    }
    const green = await provenThrough(state, results);
    if (green === results.length - 1) {
      const candidate = results[green];
      await promoteCandidate(state, candidate);
      if (landsOnTrunk(state.config)) { await landOnTrunk(state); return; }
      if (!await inlineDeferredGuards(state)) { await save(state, { state: 'blocked' }); return; }
      const proof = candidate.gate.isGreen ? { tree: candidate.gate.tree, failures: [], logPath: candidate.gate.logPath } : waivedProof(state, candidate.gate);
      if (!proof) throw new Refused('LAND_WAIVER', 'the candidate’s waiver expired; inspect the gate before adopting');
      await save(state, { state: 'ready', proof, parallelProofRoot: candidate.gate.proofRoot ?? candidate.batch.root, culprits: state.culprits });
      await publish(state);
      return;
    }
    const boundary = results[green + 1];
    if (!boundary.gate) {
      // The first non-green prefix refused before its gate: its last item's own content stopped the merge (docs
      // regeneration, a header, placement), so that item goes back with the refusal and the rest go on [C7].
      const refused = remaining[green + 1];
      state.culprits.push({ id: refused.id, commit: refused.commit, ...(refused.reviewedCommit ? { reviewedCommit: refused.reviewedCommit } : {}),
        mergeCommit: boundary.batch.tip, tests: [{ file: 'landing', name: boundary.error?.code ?? 'LAND_MERGE', assertion: boundary.error?.message ?? '' }] });
      await save(state, { culprits: state.culprits });
      await returnCulprits(state);
      state.say(`culprit #${refused.id}: ${boundary.error?.code ?? 'LAND_MERGE'} ${String(boundary.error?.message ?? '').slice(0, 160)}`);
      remaining = withoutParallelBlocker(state, remaining, refused);
      await save(state, { parallelRemaining: remaining });
      continue;
    }
    await promoteCandidate(state, boundary);
    const gate = boundary.gate;
    // The judge already charged main's cases and reran the rest once: what is left failed twice and is an item's [C7,#5862].
    const failures = boundary.red ?? gate.failures;
    const culprit = remaining[green + 1];
    const greenBase = green >= 0 && results[green].gate.isGreen && completeGate(results[green].gate)
      || parallelGreenBase(state, gate);
    if (green >= 0 && !greenBase || green === -1 && !gate.knownMainProof && failures?.length) {
      // The prefix before this item is proven, or this item ran alone on main's tip: its reds twice over are its own, so
      // it returns alone and the others land. Why: #3768's red rerun held the whole trunk as a test defect (9 Nov) [C7].
      await bisect(state, [culprit], failures);
      // A red that could not be compared with main stops this batch blocked; it holds no trunk [C7,#5862].
      if (state.flaky) return;
      remaining = withoutParallelBlocker(state, remaining, culprit);
      await save(state, { parallelRemaining: remaining });
      continue;
    }
    // A red A+B with green A can still be an interaction: B alone must reproduce those failures.
    // This is a distinct composition, not a retry of A+B or any other already tested tree.
    const [alone] = await parallelPrefixes(state, [culprit]);
    const signatures = new Set((alone.gate?.failures ?? []).map(failure => JSON.stringify([failure.file, failure.name])));
    const interaction = !alone.gate || alone.gate.isGreen || !failures.every(failure => signatures.has(JSON.stringify([failure.file, failure.name])));
    // Green alone but red together: the later item is dropped with the failing cases, never a trunk hold [C7,#5862].
    await promoteCandidate(state, interaction ? boundary : alone);
    if (interaction) await returnCulprit(state, culprit, failures, { isolated: true });
    else await bisect(state, [culprit], failures);
    if (state.flaky) return;
    remaining = withoutParallelBlocker(state, remaining, culprit);
    await save(state, { parallelRemaining: remaining });
  }
  await save(state, { state: 'blocked', culprits: state.culprits });
}
