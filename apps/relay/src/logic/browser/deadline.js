import { realRelayAdapter } from '../../io/browser-adapter.js';
/** Bound browser I/O independently of the first-paint promise [H5,H16,H17]. */
import { Refused } from '../../../../../packages/kernel/index.js';

// Budget: the existing snapshot catch-up window also bounds one browser I/O operation; first paint remains independent.
export const BROWSER_IO_TIMEOUT_MS = 15_000;

/**
 * Reject even when a browser API ignores cancellation, and cancel any work that accepts a signal.
 * Late results cannot resume the caller after its deadline. Optional parent cancellation retains
 * its original reason, while a timeout supplies actionable guidance rather than private state.
 */
export async function withBrowserDeadline(work, {
  timeoutMs = BROWSER_IO_TIMEOUT_MS, signal, code = 'RELAY_UNAVAILABLE',
  message = 'This read did not answer. Open your boards again in a moment.',
} = {}) {
  const controller = new AbortController();
  let timer;
  let cancel;
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => {
        const error = signal.reason ?? new Refused(code, message);
        controller.abort(error);
        reject(error);
      };
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        const error = new Refused(code, message);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      Promise.resolve().then(() => work(controller.signal)).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Keep the response headers and JSON body under one deadline, including a stalled response body. */
export function browserJSON(path, options = {}) {
  const { signal, adapter = realRelayAdapter, ...request } = options;
  return withBrowserDeadline(async boundedSignal => {
    const response = await adapter.request(path, { ...request, signal: boundedSignal });
    const document = response.status === 304 ? null : await response.json();
    return { response, document };
  }, { signal });
}
