/** Remove a test run's private sandbox without letting a removal failure change the run's result [C7]. */
import { rmSync } from 'node:fs';

/**
 * Remove the sandbox; on failure name it on stderr and leave it for the background sweep (#2525).
 * Why: the tests already finished, so an ENOTEMPTY or permission error here must not turn a green run red (#2538).
 */
export function removeTestSandbox(sandbox, write = text => process.stderr.write(text)) {
  try { rmSync(sandbox, { recursive: true, force: true }); return true; }
  catch (error) {
    write(`run-tests: SANDBOX_CLEANUP_DEFERRED ${sandbox} (${error?.code ?? error?.name}); the test outcome stands and the sweep removes it\n`);
    return false;
  }
}
