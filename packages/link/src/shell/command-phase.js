/** Opt-in credential-free command phases let private child watchdogs explain a stalled operation [A7,C7]. */
import {
  appendFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';

const PHASES = new Set(['waiting-relay', 'waiting-lock', 'local-export']);
const MAX_TRACE_BYTES = 1024 * 1024;
let sequence = 0;

/** An absent observer leaves production behavior unchanged and performs no file operation. */
function noPhase() {}

/** Begin one known operation; its id lets nested or concurrent operations finish independently. */
export function beginCommandPhase(phase) {
  const file = process.env.PULLBOARD_COMMAND_PHASE_FILE;
  if (!file || !PHASES.has(phase)) return noPhase;
  const id = ++sequence;
  let ended = false;
  /** Diagnostic failure cannot change the underlying command or its refusal. */
  function record(event) {
    try {
      appendFileSync(file, JSON.stringify({ pid: process.pid, id, phase, event,
        at: Date.now(), uptimeMs: performance.now() }) + '\n', { mode: 0o600 });
    } catch { /* An unavailable diagnostic file never changes command behavior. */ }
  }
  record('start');
  return () => { if (!ended) { ended = true; record('end'); } };
}

/** Report uncertainty explicitly; an absent phase is never fabricated as a zero-duration operation. */
function unavailable(pid, reason, timings = []) {
  return { pid, phase: 'unmeasured', elapsedMs: null, timings, unavailable: reason };
}

/** Read only bounded phase metadata for the actual child, excluding URLs, payloads, paths and credentials. */
export function commandPhaseSnapshot(file, pid) {
  if (!file) return unavailable(pid, 'no phase capture was configured');
  let events;
  try {
    if (statSync(file).size > MAX_TRACE_BYTES) return unavailable(pid, 'phase capture exceeded its byte bound');
    events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return unavailable(pid, 'phase capture was not available or complete'); }
  const active = new Map();
  const timings = [];
  for (const event of events) {
    if (event.pid !== pid) continue;
    if (!PHASES.has(event.phase) || !Number.isSafeInteger(event.id) || event.id < 1
        || !Number.isFinite(event.at) || !Number.isFinite(event.uptimeMs)
        || !['start', 'end'].includes(event.event)) return unavailable(pid, 'phase capture contained invalid metadata');
    if (event.event === 'start') {
      if (active.has(event.id)) return unavailable(pid, 'phase capture repeated an operation');
      active.set(event.id, event);
    } else {
      const start = active.get(event.id);
      if (!start || start.phase !== event.phase || event.uptimeMs < start.uptimeMs) return unavailable(pid, 'phase capture had an unmatched completion');
      timings.push({ phase: event.phase, elapsedMs: event.uptimeMs - start.uptimeMs, complete: true });
      active.delete(event.id);
    }
  }
  const observedAt = Date.now();
  const pending = [...active.values()].sort((left, right) => left.id - right.id);
  if (!pending.length) return unavailable(pid, 'no instrumented operation was active at the stall', timings);
  for (const start of pending) {
    if (observedAt < start.at) return unavailable(pid, 'the wall clock moved before the active phase', timings);
    timings.push({ phase: start.phase, elapsedMs: observedAt - start.at, complete: false });
  }
  const latest = pending.at(-1);
  const activePhases = [...new Set(pending.map(start => start.phase))];
  return { pid, phase: activePhases.length === 1 ? latest.phase : 'concurrent',
    activePhases, elapsedMs: observedAt - latest.at, timings, observedAt };
}
