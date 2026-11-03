/** Execute the shared gate-cell static checker with the hook's exact staged source [C7]. */
import { fileURLToPath } from 'node:url';
import { changedStaticFailures } from '../../packages/gate/index.js';
import { stagedHookFailures } from '../../packages/gate/index.js';
export { changedStaticFailures, stagedHookFailures } from '../../packages/gate/index.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staged = process.argv[2] === '--staged';
  const failures = process.argv[2] === '--staged-hook' ? stagedHookFailures(process.cwd())
    : changedStaticFailures(process.cwd(), process.argv.slice(staged ? 3 : 2), { staged });
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
}
