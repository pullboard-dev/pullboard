/** Shared observation and wait helpers for private runner fixtures [C7]. */
import { DatabaseSync } from 'node:sqlite';

/** Read the remote machine's live gate holders without changing its shared admission state. */
export function readRemoteGateHolders(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return db.prepare("SELECT token, pid, agent, browser, item, kind FROM holder WHERE name = 'gate'").all();
  } finally { db.close(); }
}

/**
 * Poll an observable state until the fixture's own signal expires; callers without a signal
 * retain their existing 20-second fallback. Timeout diagnostics describe the last observation.
 * @param {() => boolean} check
 * @param {string} label
 * @param {{signal?: AbortSignal, state?: () => unknown, onTimeout?: (message: string) => void}} options
 */
export async function waitForCondition(check, label, { signal, state, onTimeout } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let timer;
    let finished = false;
    /** Remove the poll and abort listener on every terminal path. */
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', expired);
      if (error) reject(error);
      else resolve();
    }
    /** Preserve an unavailable diagnostic as such; it never becomes an empty observed state. */
    function lastState() {
      try { return JSON.stringify(state?.() ?? 'not observed').slice(0, 2_000); }
      catch (error) { return `unavailable (${error.message})`; }
    }
    /** Explain the actual fixture deadline before rejecting the pending state wait. */
    function expired() {
      if (finished) return;
      const error = new Error(`fixture cleanup state did not arrive: ${label}; elapsed ${Math.round(performance.now() - started)} ms; last state: ${lastState()}`);
      try { onTimeout?.(error.message); }
      catch (diagnosticError) { error.message += `; timeout diagnostic failed: ${diagnosticError.message}`; }
      finish(error);
    }
    /** Test the actual condition; only the existing legacy fallback owns a separate clock. */
    function poll() {
      if (finished) return;
      if (signal?.aborted) { expired(); return; }
      let ready;
      try { ready = check(); }
      catch (error) { finish(error); return; }
      if (ready) { finish(); return; }
      // budget: preserve the existing fallback only for callers without a test-owned signal.
      if (!signal && performance.now() - started >= 20_000) { expired(); return; }
      timer = setTimeout(poll, 20); // budget: existing polling interval for a real observable state.
    }
    signal?.addEventListener('abort', expired, { once: true });
    poll();
  });
}
