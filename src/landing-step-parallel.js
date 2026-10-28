/** Coordinator landing parallel step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { localDependencyIds } from './item-dependencies.js';
import { requireOutsideOwner } from './outside-source.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from './board.js';
import { git } from './git.js';
import { isClean } from './git.js';
import { tryGit } from './git.js';
import { untracked } from './git.js';
import { runLandingCandidateWorker } from './landing-candidates.js';
import { Refused } from './refused.js';
import { validateLandingBatch } from './submit-invariants.js';
import { validateLandingRevision } from './submit-invariants.js';
import { save } from './landing-step-merge.js';
import { coveredFailures } from './landing-step-failures.js';
import { liveWaiverProjection } from './landing-step-failures.js';
import { diagnose } from './landing-step-diagnose.js';
import { waivedProof } from './landing-step-failures.js';
import { bisect } from './landing-step-diagnose.js';
import { fileFlakes } from './landing-step-diagnose.js';
import { fileTestDefects } from './landing-step-diagnose.js';
import { publish } from './landing-step-publish.js';
import { landsOnTrunk } from './landing-step-publish.js';
import { inlineDeferredGuards } from './landing-step-trunk.js';
import { landOnTrunk } from './landing-step-trunk.js';

/** Read a completed speculative result from its immutable raw log, without another execution. */
function savedCandidateResult(candidate) {
  if (!candidate.complete) return null;
  if (candidate.error) throw new Refused(candidate.error.code, candidate.error.message);
  const gate = candidate.gate;
  return { batch: candidate.snapshot, gate: gate ? { ...gate, output: readFileSync(gate.logPath, 'utf8') } : null };
}

/** Keep only small replayable gate metadata; the complete output remains in its immutable log. */
function candidateGateRecord(gate) {
  if (!gate) return null;
  const { tree, isGreen, failures, accounted, complete, requiresGreen, logPath, flakeDiagnostics, timedOut, proofRoot, proofCommit, affectedGate } = gate;
  return { tree, isGreen, failures, accounted, complete, requiresGreen, logPath, affectedGate,
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
    const previous = savedCandidateResult(descriptor);
    if (previous) return previous;
    const key = descriptor.key;
    /** Virtual child batches append deltas to their one canonical parent, never overwrite it. */
    const write = async (operation, args) => {
      if (operation === 'claimGate') {
        const [tree, affectedGate] = args;
        const recorded = state.gates.get(tree);
        if (recorded?.timedOut) throw new Refused('LAND_GATE_TIMEOUT', 'this exact tree has a recorded landing timeout; inspect its log before starting a new batch');
        const cached = recorded?.affectedGate === affectedGate ? recorded : null;
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
  const observations = store.flakeLedger(state.board).flatMap(row => row.observations).filter(row => ids.has(row.id));
  return gate.failures.length > 0 && gate.failures.every(failure => observations.some(observation => observation.file === failure.file
    && observation.name === failure.name && observation.main === state.batch.base
    && observation.classification === 'possible-regression' && observation.mainReceipt?.green === true));
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
    const green = results.findLastIndex(result => result.gate?.isGreen || result.gate && waivedProof(state, result.gate));
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
    await promoteCandidate(state, boundary);
    const gate = boundary.gate;
    const flakyFiles = await diagnose(state, gate.failures, gate);
    if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; return; }
    const culprit = remaining[green + 1];
    const greenBase = green >= 0 && results[green].gate.isGreen && completeGate(results[green].gate)
      || parallelGreenBase(state, gate);
    if (!greenBase) { await fileTestDefects(state, gate); state.flaky = true; return; }
    // A red A+B with green A can still be an interaction: B alone must reproduce those failures.
    // This is a distinct composition, not a retry of A+B or any other already tested tree.
    const [alone] = await parallelPrefixes(state, [culprit]);
    const signatures = new Set((alone.gate?.failures ?? []).map(failure => JSON.stringify([failure.file, failure.name])));
    if (!alone.gate || alone.gate.isGreen || !gate.failures.every(failure => signatures.has(JSON.stringify([failure.file, failure.name])))) {
      await promoteCandidate(state, boundary);
      await fileTestDefects(state, gate);
      state.flaky = true;
      return;
    }
    await promoteCandidate(state, alone);
    const aloneFlakes = await diagnose(state, alone.gate.failures, alone.gate);
    if (aloneFlakes.length) { await fileFlakes(state, alone.gate, aloneFlakes); state.flaky = true; return; }
    await bisect(state, [culprit], gate.failures);
    remaining = withoutParallelBlocker(state, remaining, culprit);
    await save(state, { parallelRemaining: remaining });
  }
  await save(state, { state: 'blocked', culprits: state.culprits });
}
