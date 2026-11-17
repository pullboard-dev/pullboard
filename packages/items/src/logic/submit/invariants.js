/** Read-only submit-invariant proposals from recorded selection and exact-commit evidence [C7,V4]. */
import { Refused } from "../../../../kernel/index.js";
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';

const BUDGET_MS = 60_000;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Accept only literal project-relative paths that can be displayed and configured safely. */
function projectFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[:\\\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}


import { SUBMISSION_PROOF_ENGINE } from "../../../../state/index.js";

/** Accept only measured finite nonnegative durations; unavailable is always null. */
function duration(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

/** Retain printed whole-file timings only; never sum case bodies into a file runtime. */
export function landingFileTimes(root, profile) {
  return (profile?.files ?? []).flatMap(file => {
    if (typeof file?.path !== 'string') return [];
    const path = (isAbsolute(file.path) ? relative(root, file.path) : file.path).replace(/^\.\//u, '');
    return projectFile(path) && duration(file.durationMs) !== null ? [{ path, durationMs: file.durationMs }] : [];
  });
}

/** Validate canonical landing evidence before a move can change the board. */
export function invariantEvidence(value) {
  if (value === undefined) return undefined;
  /** Raise a typed refusal before malformed evidence can reach the canonical event log. */
  const bad = () => { throw new Refused('LAND_EVIDENCE', 'landing invariant evidence needs exact commits, participating submissions and literal test files; rerun land with the current CLI'); };
  if (!value || value.version !== 1 || !Array.isArray(value.gates) || !Array.isArray(value.diagnostics)) bad();
  const gates = value.gates.map(gate => {
    if (!gate || !COMMIT.test(gate.commit ?? '') || typeof gate.isGreen !== 'boolean'
      || !Array.isArray(gate.submissions) || !Array.isArray(gate.failures) || !Array.isArray(gate.fileTimes)) bad();
    if (gate.submissions.some(row => !Number.isSafeInteger(row?.id) || row.id < 1 || !COMMIT.test(row.commit ?? ''))
      || gate.failures.some(file => !projectFile(file))
      || gate.fileTimes.some(row => !projectFile(row?.path) || row.durationMs !== null && duration(row.durationMs) === null)) bad();
    return { commit: gate.commit, isGreen: gate.isGreen,
      submissions: gate.submissions.map(row => ({ id: row.id, commit: row.commit })),
      failures: [...new Set(gate.failures)].sort(),
      fileTimes: gate.fileTimes.map(row => ({ path: row.path, durationMs: row.durationMs })) };
  });
  const diagnostics = value.diagnostics.map(row => {
    if (!row || !COMMIT.test(row.commit ?? '') || !projectFile(row.test) || typeof row.isGreen !== 'boolean'
      || row.wallMs !== null && duration(row.wallMs) === null) bad();
    return { commit: row.commit, test: row.test, isGreen: row.isGreen, wallMs: row.wallMs };
  });
  return { version: 1, gates, diagnostics };
}

/** Propose escaped files without inspecting mutable logs, inferring legacy coverage or editing config. */
export function submitInvariantProposals(events, config) {
  if (config.submitGate !== 'landing') return [];
  const selections = new Map();
  for (const event of events) {
    if (event.event_kind !== 'submit') continue;
    const detail = JSON.parse(event.event_detail);
    if (detail.submissionProof) selections.set(`${event.item_id}:${detail.commit}`, detail.submissionProof);
  }
  const gates = [];
  const diagnostics = [];
  const seen = new Set();
  for (const event of events) {
    if (event.event_kind !== 'landing_batch') continue;
    const { batch } = JSON.parse(event.event_detail);
    if (!batch?.invariantEvidence) continue;
    for (const [kind, target] of [['gates', gates], ['diagnostics', diagnostics]]) {
      batch.invariantEvidence[kind].forEach((row, index) => {
        const identity = `${batch.id}:${kind}:${index}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        target.push({ ...row, order: event.event_id });
      });
    }
  }
  const proposals = new Map();
  for (const gate of gates) {
    if (gate.isGreen) continue;
    for (const file of gate.failures) {
      if ((config.submitInvariants ?? []).includes(file)) continue;
      if (gates.some(other => other.commit === gate.commit && other.isGreen && other.order >= gate.order)
        || diagnostics.some(row => row.commit === gate.commit && row.test === file && row.isGreen && row.order >= gate.order)) continue;
      const outside = gate.submissions.filter(row => {
        const proof = selections.get(`${row.id}:${row.commit}`);
        return proof && !(proof.full && !proof.deferred) && !proof.files.includes(file);
      });
      if (!outside.length) continue;
      const entry = proposals.get(file) ?? { file, merges: new Set(), runtimes: [], submissions: new Map() };
      entry.merges.add(gate.commit);
      for (const row of outside) entry.submissions.set(`${row.id}:${row.commit}`, row);
      for (const row of gate.fileTimes) if (row.path === file && duration(row.durationMs) !== null) entry.runtimes.push(row.durationMs);
      for (const row of diagnostics) if (row.commit === gate.commit && row.test === file && duration(row.wallMs) !== null) entry.runtimes.push(row.wallMs);
      proposals.set(file, entry);
    }
  }
  return [...proposals.values()].map(entry => {
    const runtimeMs = entry.runtimes.length ? Math.max(...entry.runtimes) : null;
    return { file: entry.file, escapes: entry.merges.size, runtimeMs, budgetMs: BUDGET_MS,
      withinBudget: runtimeMs === null ? null : runtimeMs < BUDGET_MS,
      commits: [...entry.merges].sort(), submissions: [...entry.submissions.values()].sort((a, b) => a.id - b.id || a.commit.localeCompare(b.commit)) };
  }).sort((a, b) => Number(b.escapes >= 2 && b.withinBudget === true) - Number(a.escapes >= 2 && a.withinBudget === true)
    || Number(b.withinBudget === true) - Number(a.withinBudget === true) || b.escapes - a.escapes || a.file.localeCompare(b.file));
}

/** Render a proposal with its measured budget and the explicit human-controlled next step. */
export function submitInvariantLine(proposal) {
  const runtime = proposal.runtimeMs === null ? 'unmeasured' : `${(proposal.runtimeMs / 1000).toFixed(2)} s`;
  const budget = proposal.withinBudget === null ? '' : proposal.withinBudget ? ' (within budget)' : ' (over budget)';
  return `submit invariant proposal: ${proposal.file}; ${proposal.escapes} escaped merge(s); runtime ${runtime} / 60 s${budget}; edit submitInvariants on main to accept`;
}

/** Validate the existing canonical batch identity before its append-only snapshot is recorded. */
export function validateLandingBatch(batch, revision) {
  if (!batch || batch.version !== 1 || typeof batch.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(batch.id)
    || !['merging', 'gating', 'bisecting', 'flaky', 'test-defect', 'blocked', 'ready', 'pushed', 'trunk', 'landed'].includes(batch.state)
    || !/^[a-f0-9]{40,64}$/u.test(batch.base ?? '') || !/^[a-f0-9]{40,64}$/u.test(batch.tip ?? '')
    || typeof batch.root !== 'string' || !batch.root || typeof batch.branch !== 'string' || !batch.branch.startsWith('refs/heads/')
    || !Array.isArray(batch.items) || batch.items.some((entry) => !Number.isSafeInteger(entry?.id) || entry.id < 1 || !/^[a-f0-9]{40,64}$/u.test(entry.commit ?? ''))
    || typeof batch.owner !== 'string' || !batch.owner || typeof batch.logPath !== 'string' || !batch.logPath
    || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Refused('LAND_BATCH', 'a landing batch needs its exact base, tip, items, state, owner and log path; run pullboard land');
  }
  // The exact-tree record is optional (batches recorded before it have none); when present it names a full tree id [V16,RFC 0011 ET1].
  if (batch.exactTree !== undefined && (!batch.exactTree || typeof batch.exactTree !== 'object' || !/^[a-f0-9]{40,64}$/u.test(batch.exactTree.tree ?? ''))) {
    throw new Refused('LAND_BATCH', `a landing batch's exact-tree record needs the full tree id of its tip, not ${JSON.stringify(batch.exactTree?.tree ?? null)}; run pullboard land`);
  }
  if (batch.exactTree?.result !== undefined && batch.exactTree.result !== 'green' && batch.exactTree.result !== 'red') {
    throw new Refused('LAND_BATCH', `a landing batch's exact-tree result is green or red, not ${JSON.stringify(batch.exactTree.result)}; run pullboard land`);
  }
}

/** Preserve earlier normalized gate and diagnostic receipts when an engine-38 batch is adopted. */
export function preserveInvariantEvidence(previous, evidence, engine) {
  if (previous?.invariantEvidence && engine >= SUBMISSION_PROOF_ENGINE) {
    for (const kind of ['gates', 'diagnostics']) {
      if (!evidence || JSON.stringify(evidence[kind].slice(0, previous.invariantEvidence[kind].length)) !== JSON.stringify(previous.invariantEvidence[kind])) {
        throw new Refused('LAND_EVIDENCE', 'recorded landing evidence is append-only; preserve earlier gate and diagnostic receipts when adopting');
      }
    }
  }
}

/** Keep the original revision, terminal-state and immutable batch-identity guards together. */
export function validateLandingRevision(previous, batch, revision) {
  if ((previous?.revision ?? 0) !== revision || previous?.state === 'landed') {
    throw new Refused('LAND_MOVED', 'the landing batch changed; read pullboard resume and adopt its current revision');
  }
  // A batch rebuilt on a trunk that moved outside its files records the base it left; any other base change is a
  // different batch. Why: the rebuild saved a new base, this guard refused it, and the worker crashed on 6 Nov [C7].
  const rebased = previous && batch.base !== previous.base && batch.rebasedFrom === previous.base;
  if (previous && ((previous.base !== batch.base && !rebased) || previous.root !== batch.root || previous.branch !== batch.branch)) {
    throw new Refused('LAND_BATCH', 'a batch keeps its original base and landing worktree; adopt it with pullboard land --adopt');
  }
}
