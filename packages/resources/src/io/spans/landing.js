/**
 * Structured landing telemetry: one span per step of an automatic landing (preflight, lease, compose, smoke, prove,
 * static, record, publish), with the gate-spans recorder pattern [C7]. The jobs cell keeps the daily span files, in
 * their own folder beside the gate spans; `pullboard gate-health` reads them with the board's accept and merged events,
 * so a slow accept-to-merged names the step that ate the time.
 *
 * Why the environment carries the sink: a landing runs its candidate in a spawned worker (apps/lib/src/io/landing/candidate.js),
 * and that child must record into the same landing run as its parent without a new argument through every layer.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendGateSpan } from '../../../../jobs/index.js';
import { gateSpanFolder } from '../../../../jobs/index.js';
import { readGateSpans } from '../../../../jobs/index.js';

/** The environment keys naming this process's open landing span sink: its folder and its run id. */
const FOLDER_KEY = 'PULLBOARD_LANDING_SPAN_FOLDER';
const RUN_KEY = 'PULLBOARD_LANDING_SPAN_RUN';

/**
 * The folder holding the machine's daily landing span files: a sibling of the gate span folder.
 *
 * @param {string} commonDir - The repository's common Git directory.
 * @returns {string}
 */
export function landingSpanFolder(commonDir) {
  return join(gateSpanFolder(commonDir), '..', 'landing-spans');
}

/**
 * Open this process's landing span sink for one landing run and return the run id; spawned children inherit it.
 *
 * @param {{ commonDir: string, run?: string }} target
 * @returns {string} The run id every later span names.
 */
export function openLandingSpans({ commonDir, run = randomUUID() }) {
  process.env[FOLDER_KEY] = landingSpanFolder(commonDir);
  process.env[RUN_KEY] = run;
  return run;
}

/** Close this process's landing span sink; later spans record nothing. */
export function closeLandingSpans() {
  delete process.env[FOLDER_KEY];
  delete process.env[RUN_KEY];
}

/**
 * Append one landing step span. `start` and `end` are epoch milliseconds. With no open sink nothing is recorded.
 * Why it never throws: telemetry must never change a landing's outcome.
 *
 * @param {{ phase: string, start: number, end?: number, items?: number[], outcome?: string, code?: string|null,
 *   host?: string|null, cause?: string|null, runKind?: string|null }} span - `host`, `cause` and `runKind` name a runner dispatch's step.
 * @returns {object|null} The recorded line, or null when no sink is open or the write failed.
 */
export function recordLandingSpan({ phase, start, end = Date.now(), items = [], outcome = 'ok', code = null, host = null, cause = null, runKind = null }) {
  const folder = process.env[FOLDER_KEY], run = process.env[RUN_KEY];
  if (!folder || !run || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const line = { v: 1, job: run, kind: 'landing', phase, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    ms: Math.max(0, Math.round(end - start)), items: items.filter(Number.isSafeInteger), outcome, ...(code ? { code: String(code).slice(0, 80) } : {}),
    ...(host ? { host } : {}), ...(cause ? { cause } : {}), ...(runKind ? { runKind } : {}) };
  try { appendGateSpan(folder, line); return line; }
  catch { return null; /* Telemetry is diagnostic; the landing's own result stands without it. */ }
}

/**
 * Run one landing step and record its span, even when it throws; a refusal's code rides on the span.
 *
 * @param {string} phase
 * @param {() => any} work
 * @param {{ items?: number[] }} [options]
 * @returns {Promise<any>} whatever the work returns
 */
export async function landingSpan(phase, work, { items = [] } = {}) {
  const start = Date.now();
  try {
    const result = await work();
    recordLandingSpan({ phase, start, items });
    return result;
  } catch (error) {
    recordLandingSpan({ phase, start, items, outcome: 'failed', code: error?.code ?? error?.name ?? null });
    throw error;
  }
}

/**
 * Read the landing spans that ended at or after `since`. A read creates no folder.
 *
 * @param {string} commonDir
 * @param {{ since: number, now?: number }} window
 * @returns {object[]}
 */
export function readLandingSpans(commonDir, window) {
  return readGateSpans(landingSpanFolder(commonDir), window).filter(span => span.kind === 'landing');
}
