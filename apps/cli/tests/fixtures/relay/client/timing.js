/** Capture bounded three-replica phases without including fixture contents or credentials [H16,V1,V17]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

/** Keep sanitized timings for three-clone tests without extending their test timeout. */
export function threeReplicaPhaseCapture(t) {
  const testStartedAt = performance.now();
  const completed = [];
  let active = null;
  let timeoutSignal = null;

  /** Record a completed phase without fixture contents or credentials. */
  function finishPhase() {
    if (!active) return;
    completed.push({
      phase: active.phase,
      startedAtMs: Math.round(active.startedAt - testStartedAt),
      elapsedMs: Math.round(performance.now() - active.startedAt),
      lastCompletedWait: active.lastCompletedWait,
      waitingDescription: active.waitingDescription ?? null,
      completedWaits: active.completedWaits,
      activeWaits: active.activeWaits.map(({ operation, startedAt }) => ({ operation, elapsedMs: Math.round(performance.now() - startedAt) })),
    });
    active = null;
  }

  /** Return phase names, timings and safe error identifiers only. */
  function snapshot(outcome, error = null) {
    const now = performance.now();
    const running = active && {
      phase: active.phase,
      startedAtMs: Math.round(active.startedAt - testStartedAt),
      elapsedMs: Math.round(now - active.startedAt),
      waitingOn: active.activeWaits.at(-1)?.operation ?? active.waitingDescription ?? null,
      waitingElapsedMs: active.activeWaits.length ? Math.round(now - active.activeWaits.at(-1).startedAt) : null,
      activeWaits: active.activeWaits.map(({ operation, startedAt }) => ({ operation, elapsedMs: Math.round(now - startedAt) })),
      completedWaits: active.completedWaits,
      lastCompletedWait: active.lastCompletedWait,
    };
    return {
      outcome,
      timeoutSignalled: timeoutSignal !== null,
      timeoutSignalName: timeoutSignal?.name ?? null,
      timeoutSignalCode: timeoutSignal?.code ?? null,
      totalElapsedMs: Math.round(now - testStartedAt),
      activePhase: running?.phase ?? null,
      activeWait: running,
      lastCompletedPhase: completed.at(-1)?.phase ?? null,
      completedPhases: completed,
      errorName: error?.name ?? null,
      errorCode: error?.code ?? null,
    };
  }

  /** Emit a bounded timing record without replacing the original test result. */
  function report(outcome, error = null) {
    try { process.stderr.write('[three-replica-phase] ' + JSON.stringify(snapshot(outcome, error)) + '\n'); }
    catch { /* Diagnostics must never replace the original failure or timeout. */ }
  }

  const onAbort = () => {
    timeoutSignal = t.signal.reason ?? new Error('test timeout signal');
    report('timeout-signal', timeoutSignal);
  };
  t.signal?.addEventListener('abort', onAbort, { once: true });
  t.after(() => {
    t.signal?.removeEventListener('abort', onAbort);
    report('test-after-hook');
  });

  return {
    /** Start a phase with a safe description of the operation. */
    begin(phase, waitingOn) {
      finishPhase();
      active = { phase, startedAt: performance.now(), activeWaits: [], completedWaits: [], lastCompletedWait: null };
      if (waitingOn) active.waitingDescription = waitingOn;
    },
    /** Time one operation and name the wait before yielding. */
    async wait(label, operation) {
      assert.ok(active, 'a named phase is active before every asynchronous wait');
      const phase = active;
      const frame = { operation: label, startedAt: performance.now() };
      phase.activeWaits.push(frame);
      let outcome = 'resolved';
      try {
        return await operation();
      } catch (error) {
        outcome = error?.name ?? 'rejected';
        throw error;
      } finally {
        const waitReceipt = { operation: label, elapsedMs: Math.round(performance.now() - frame.startedAt), outcome };
        phase.completedWaits.push(waitReceipt);
        phase.lastCompletedWait = waitReceipt;
        const index = phase.activeWaits.indexOf(frame);
        if (index !== -1) phase.activeWaits.splice(index, 1);
      }
    },
    /** Run the existing body and report the original thrown object. */
    async run(body) {
      try {
        return await body();
      } catch (error) {
        report('test-error', error);
        throw error;
      }
    },
    /** Finish the last phase and require the named sequence to match. */
    finish(expected) {
      finishPhase();
      assert.deepEqual(completed.map(({ phase }) => phase), expected, 'all named relay phases completed in order');
      assert.ok(completed.every((phase) => Number.isFinite(phase.startedAtMs) && Number.isFinite(phase.elapsedMs)),
        'every phase has finite start and elapsed timings');
      return completed;
    },
  };
}
