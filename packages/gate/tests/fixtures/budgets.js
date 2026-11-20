/** CLI and test entry for the gate's shipped wall-clock policy. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export { fixedWallMargins, wallClockViolations } from '../../index.js';
import { wallClockViolations } from '../../heavy.js';

// Imports remain side-effect free; Pullboard's own gate invokes this same scanner directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = wallClockViolations(process.cwd());
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  }
}
