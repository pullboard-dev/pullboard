/** Shared real placement fixtures retain native CLI ownership and normal Git hooks [L3,C7]. */
import assert from 'node:assert/strict';

/** Keep actual native command failures in every setup assertion. */
export function success(box, cwd, ...args) {
  const run = box.run(cwd, ...args, '--no-next', '--json');
  assert.equal(run.code, 0, run.out + run.err);
  return JSON.parse(run.out);
}
