import { performance } from 'node:perf_hooks';

/** A fixture handshake and release, independent of elapsed-time guesses. */
export function journeyDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Create the shared absolute monotonic deadline for one hosted journey. */
export function createJourneyDeadline({ timeoutMs, onTimeout, now = () => performance.now() } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite non-negative number');
  }
  if (typeof onTimeout !== 'function') {
    throw new TypeError('onTimeout must be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new TypeError('now() must return a finite monotonic timestamp');
  const deadlineAt = startedAt + timeoutMs;
  let phase = 'journey-not-started';
  let cleanupStage = 'cleanup-not-started';
  let timer;
  let disposed = false;
  let expiredError;
  const activeWaits = new Map();
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  // A deadline may expire between waits. Keep that deferred rejection observed.
  timeoutPromise.catch(() => {});

  /** Construct the one shared error and invoke only the caller-provided abort action. */
  const expire = () => {
    if (expiredError) return expiredError;
    const waitLabel = activeWaits.size ? activeWaits.values().next().value : null;
    const error = new Error(`hosted journey deadline exceeded during phase ${phase} at cleanup stage ${cleanupStage}${waitLabel ? ` while waiting for ${waitLabel}` : ''}`);
    error.name = 'JourneyDeadlineExceededError';
    error.phase = phase;
    error.cleanupStage = cleanupStage;
    error.waitLabel = waitLabel;
    expiredError = error;
    try {
      const result = onTimeout(error);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      // Timeout handling must not replace the deadline error.
    }
    rejectTimeout(error);
    return error;
  };

  /** Schedule against the original deadline rather than extending it after each wait. */
  const armTimer = () => {
    if (disposed || expiredError) return;
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(armTimer, Math.min(remaining, 2_147_483_647));
  };
  armTimer();

  /** Race one caller-owned operation against the shared deadline without claiming cancellation. */
  const wait = async (label, promiseOrCallback) => {
    if (disposed) throw new Error('hosted journey deadline is disposed');
    const waitLabel = String(label);
    if (!waitLabel) throw new TypeError('wait label must not be empty');
    if (expiredError || deadlineAt - now() <= 0) throw expire();
    if (typeof promiseOrCallback !== 'function'
        && (!promiseOrCallback || typeof promiseOrCallback.then !== 'function')) {
      throw new TypeError('wait expects a promise or callback returning a promise/value');
    }
    const waitToken = Symbol(waitLabel);
    activeWaits.set(waitToken, waitLabel);
    let operation;
    try {
      operation = Promise.resolve().then(() => {
        if (deadlineAt - now() <= 0) throw expire();
        return typeof promiseOrCallback === 'function' ? promiseOrCallback() : promiseOrCallback;
      });
    } catch (error) {
      activeWaits.delete(waitToken);
      throw error;
    }
    // Promise.race observes late rejection too; it does not cancel the operation. The caller
    // remains responsible for draining/closing any owned work after a deadline error.
    const observedOperation = operation.then((value) => {
      if (deadlineAt - now() <= 0) throw expire();
      return value;
    }, (error) => {
      if (deadlineAt - now() <= 0) throw expire();
      throw error;
    });
    try {
      return await Promise.race([observedOperation, timeoutPromise]);
    } finally {
      activeWaits.delete(waitToken);
    }
  };

  return {
    /** Report time remaining before the shared absolute deadline. */
    remainingMs() {
      return Math.max(0, deadlineAt - now());
    },
    /** Set the current static journey phase included in deadline errors. */
    setPhase(value) {
      phase = String(value);
    },
    /** Set the current static cleanup stage included in deadline errors. */
    setCleanupStage(value) {
      cleanupStage = String(value);
    },
    wait,
    /** Stop the timer after the caller has completed or drained its owned work. */
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/** Drain dynamically appended task promises in batches against one shared deadline. */
export async function drainJourneyTasks(tasks, deadline) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be a mutable array');
  if (!deadline || typeof deadline.wait !== 'function') {
    throw new TypeError('deadline must provide wait(label, promiseOrCallback)');
  }
  let consumed = 0;
  const failures = [];
  while (consumed < tasks.length) {
    const batch = tasks.slice(consumed);
    consumed += batch.length;
    // A deadline rejection propagates directly; only settled task failures are accumulated.
    const results = await deadline.wait('interception tasks', () => Promise.allSettled(batch));
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${failures.length} hosted journey task${failures.length === 1 ? '' : 's'} failed`);
  }
}
