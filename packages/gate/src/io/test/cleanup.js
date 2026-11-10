/** Remove a test run's private sandbox without letting a removal failure change the run's result [C7]. */
import { rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { TEST_CHILD_CLEANUP_FAILED } from './drain.js';

/** Errors a still-writing child causes while the tree is removed: the directory gained an entry, or was in use. */
const RETRYABLE = new Set(['ENOTEMPTY', 'EBUSY', 'EEXIST']);
/** Waits between removal attempts, in milliseconds: about 6 s in all for a child to finish writing and exit. */
const BACKOFF_MS = [50, 100, 200, 400, 800, 1600, 3000];

/** Block this cleanup for a moment; the tests have finished, so nothing else in the run is waiting on it. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove the sandbox, retrying with backoff while a child that outlived its test still writes into it (#2527); on
 * failure name it on stderr and leave it for the background sweep (#2525).
 * Why: the tests already finished, so an ENOTEMPTY or permission error here must not turn a green run red (#2538).
 */
export function removeTestSandbox(sandbox, write = text => process.stderr.write(text), { backoff = BACKOFF_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (existsSync(sandbox) && readdirSync(sandbox).some(name => name === TEST_CHILD_CLEANUP_FAILED || name.startsWith(TEST_CHILD_CLEANUP_FAILED + '-'))) {
        write(`run-tests: SANDBOX_CLEANUP_DEFERRED ${sandbox} (owned child still running); the test outcome stands and the sweep removes it\n`);
        return false;
      }
      rmSync(sandbox, { recursive: true, force: true });
      return true;
    }
    catch (error) {
      if (RETRYABLE.has(error?.code) && attempt < backoff.length) { pause(backoff[attempt]); continue; }
      write(`run-tests: SANDBOX_CLEANUP_DEFERRED ${sandbox} (${error?.code ?? error?.name}); the test outcome stands and the sweep removes it\n`);
      return false;
    }
  }
}
