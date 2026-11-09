/**
 * Structured gate telemetry: one span per phase of a queued submit gate [C7]. A gate's worker opens the sink for its
 * own job; every phase it runs in this process records through it, and a process with no open sink records nothing.
 * The jobs cell keeps the span files.
 */
import { appendGateSpan } from '../../../jobs/index.js';

/** The typed failure causes a span may carry: readiness-miss, transport-lost, runner-dropped, deadline, infra-retry. */

/** Runner work kinds that are analysis, not the gate's test proof. */
const ANALYSIS_KINDS = new Set(['analysis', 'cells', 'doctrine', 'composition', 'selection', 'static', 'submit-changed-static', 'submit-placement']);

/** The one open sink of this process: a gate worker drives exactly one gate. */
let sink = null;

/**
 * Open this process's sink for one gate job; every later span names the job and item.
 *
 * @param {{ folder: string, job: string, item: number }} target - `folder` is the jobs cell's gateSpanFolder.
 */
export function openGateSpans({ folder, job, item }) {
  sink = { folder, job, item: Number(item) };
}

/** Close this process's sink; later spans record nothing. */
export function closeGateSpans() {
  sink = null;
}

/**
 * Append one phase span for the open gate. `start` and `end` are epoch milliseconds. A missing sink records nothing.
 * Why it never throws: telemetry must never change a gate's verdict.
 *
 * @param {{ phase: string, start: number, end?: number, host?: string|null, outcome?: string, cause?: string|null,
 *   code?: string|null, kind?: string|null }} span
 * @returns {object|null} The recorded line, or null when no sink is open or the write failed.
 */
export function recordGateSpan({ phase, start, end = Date.now(), host = null, outcome = 'ok', cause = null, code = null, kind = null }) {
  if (!sink || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const line = { v: 1, job: sink.job, item: sink.item, phase, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    ms: Math.max(0, Math.round(end - start)), host: host || 'local', outcome,
    ...(cause ? { cause } : {}), ...(code ? { code: String(code).slice(0, 80) } : {}), ...(kind ? { kind } : {}) };
  try { appendGateSpan(sink.folder, line); return line; }
  catch { return null; /* Telemetry is diagnostic; the gate's own result stands without it. */ }
}

/**
 * The typed cause of a gate phase failure, or null when it is not an infrastructure failure.
 *
 * @param {any} error
 * @returns {string|null}
 */
export function gateSpanCause(error) {
  if (error?.diagnostic?.reason === 'admission-deadline') return 'readiness-miss';
  if (error?.code === 'RUNNER_WAIT_DEADLINE') return 'deadline';
  if (['RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST'].includes(error?.code)) return 'runner-dropped';
  if (['RUNNER_INFRA_RETRY_EXHAUSTED', 'GATE_INFRA_EXHAUSTED'].includes(error?.code)) return 'infra-retry';
  if (error?.name === 'RunnerDropped' || error?.code === 'TRANSPORT_LOST') return 'transport-lost';
  return null;
}

/**
 * The spans of one runner dispatch from its recorded phase marks: `transfer` from connecting until the source is sent,
 * `ready` from then until the worker said READY, and `tests` (or `remote-analysis` for analysis work) until it ended.
 * A failed dispatch is one span for the phase it was in, carrying its typed cause.
 *
 * @param {{ startedAt: number, endedAt: number, host?: string|null, kind?: string|null, phases?: Record<string, number>|null, error?: any }} run
 * @returns {object[]} Span arguments for recordGateSpan.
 */
function runnerDispatchSpans({ startedAt, endedAt, host = null, kind = null, phases = null, error = null }) {
  const work = ANALYSIS_KINDS.has(kind) ? 'remote-analysis' : 'tests';
  if (error) {
    const phase = error.diagnostic?.phase;
    const failed = phase === 'ready' ? work : phase === 'source-sent' ? 'ready' : 'transfer';
    return [{ phase: failed, start: startedAt, end: endedAt, host, kind, outcome: 'failed', cause: gateSpanCause(error), code: error.code ?? error.diagnostic?.reason ?? error.name }];
  }
  const ready = phases?.ready;
  if (!Number.isFinite(ready)) return [{ phase: work, start: startedAt, end: endedAt, host, kind }];
  const sent = Math.min(ready, [phases['source-sent'], phases.pack, phases.inventory].find(Number.isFinite) ?? ready);
  return [
    { phase: 'transfer', start: phases.connect ?? startedAt, end: sent, host, kind },
    { phase: 'ready', start: sent, end: ready, host, kind },
    { phase: work, start: ready, end: endedAt, host, kind },
  ];
}

/**
 * Record every span of one runner dispatch for the open gate.
 *
 * @param {Parameters<typeof runnerDispatchSpans>[0]} run
 */
export function recordRunnerDispatch(run) {
  if (!sink) return;
  for (const span of runnerDispatchSpans(run)) recordGateSpan(span);
}
