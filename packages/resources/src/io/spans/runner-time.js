/**
 * The runner-time sidecar: one line per runner dispatch with its host, item, kind and minutes, written whether or not a
 * gate or landing run is open [C7,#8183]. Why: a dispatch's phase spans land only in an open gate or landing run, so
 * the rest of the runner time (focused test runs, checks, comparisons) had no record and no one to charge it to.
 * The jobs cell keeps the daily files beside the gate spans; `pullboard gate-health` reads them.
 */
import { appendGateSpan } from '../../../../jobs/index.js';
import { runnerTimeFolder } from '../../../../jobs/index.js';
import { repoInfo } from '../../../../git/light.js';

/** The longest an item or kind label is kept on a line. */
const LABEL_LIMIT = 80;

/** A label as a bounded string; an unnamed one is the empty string, which the report counts as unattributed. */
function label(value) {
  return String(value ?? '').trim().slice(0, LABEL_LIMIT);
}

/**
 * Append one runner dispatch to the sidecar of the repository at `root`. A dispatch that failed is recorded too, with
 * its outcome, since the runner was held either way. Why it never throws: telemetry must never change a run's result.
 *
 * @param {string} root - A checkout of the repository the dispatch ran for.
 * @param {{ startedAt: number, endedAt?: number, host?: string|null, item?: unknown, kind?: unknown, error?: any }} dispatch
 *   Epoch milliseconds, the runner host, and the metadata item and kind the caller named (empty when it named none).
 * @returns {object|null} The recorded line, or null when nothing was written.
 */
export function recordRunnerTime(root, { startedAt, endedAt = Date.now(), host = null, item = '', kind = '', error = null }) {
  if (typeof root !== 'string' || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  try {
    const commonDir = repoInfo(root)?.commonDir;
    if (!commonDir) return null;
    const ms = Math.max(0, Math.round(endedAt - startedAt));
    const line = { v: 1, host: host || 'local', item: label(item), kind: label(kind), minutes: Math.round(ms / 60) / 1000,
      start: new Date(startedAt).toISOString(), end: new Date(endedAt).toISOString(), outcome: error ? 'failed' : 'ok',
      ...(error ? { code: String(error.code ?? error.name ?? 'error').slice(0, 80) } : {}) };
    appendGateSpan(runnerTimeFolder(commonDir), line);
    return line;
  } catch { return null; /* Telemetry is diagnostic; the run's own result stands without it. */ }
}
