/** Read-only submit-invariant proposals from recorded selection and exact-commit evidence [C7,V4]. */
import { Refused } from './refused.js';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { KNOWN_MAIN_FAILURES_ENGINE } from './known-main-failures-engine.js';

export const SUBMISSION_PROOF_ENGINE = 38;
const BUDGET_MS = 60_000;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Accept only literal project-relative paths that can be displayed and configured safely. */
function projectFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[:\\\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Normalize the receipt required by modern submits; legacy replay skips this guard. */
export function submissionProof(value, engine = KNOWN_MAIN_FAILURES_ENGINE) {
  if (!value || value.version !== 1 || typeof value.full !== 'boolean'
    || typeof value.deferred !== 'boolean' || typeof value.reason !== 'string'
    || value.reason.length > 8192 || !Array.isArray(value.files) || value.files.some(file => !projectFile(file))
    || value.deferredFiles !== undefined && (!value.deferred || !Array.isArray(value.deferredFiles) || value.deferredFiles.some(file => !projectFile(file)))) {
    throw new Refused('SUBMISSION_PROOF', 'a submission proof needs its version, selected project files, full-fallback reason and deferred flag; rerun submit with the current CLI');
  }
  const known = value.knownMainFailures;
  if (known !== undefined && (engine < KNOWN_MAIN_FAILURES_ENGINE || !known || !COMMIT.test(known.main ?? '')
    || !Array.isArray(known.failures) || !known.failures.length || known.failures.some(row => !projectFile(row?.file)
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || !/^[a-f0-9]{64}$/u.test(row.signature ?? '')))) {
    throw new Refused('SUBMISSION_PROOF', 'known main failures need their exact main commit, project test files, names and failure signatures on a supporting engine');
  }
  return { version: 1, files: [...new Set(value.files)].sort(), full: value.full,
    deferred: value.deferred, reason: value.reason, ...(value.deferredFiles ? { deferredFiles: [...new Set(value.deferredFiles)].sort() } : {}),
    ...(known ? { knownMainFailures: { main: known.main, failures: known.failures.map(({ file, name, signature }) => ({ file, name, signature })) } } : {}) };
}

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
  if (previous && (previous.base !== batch.base || previous.root !== batch.root || previous.branch !== batch.branch)) {
    throw new Refused('LAND_BATCH', 'a batch keeps its original base and landing worktree; adopt it with pullboard land --adopt');
  }
}
