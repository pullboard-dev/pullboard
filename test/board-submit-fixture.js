/** Board-state fixtures supply the receipt required by modern submits [C7,V4]. */
import { submit } from '../src/board.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Construct the existing stale-verdict check and read its exact immutable per-fixture invocation log. */
export function staleVerdictCheckFixture(directory) {
  const checkedHeads = join(directory, 'checked-heads');
  const check = `grep -q '^feature = 1$' web/feature.js && git rev-parse HEAD >> '${checkedHeads}'`;
  /** Preserve raw check-log bytes and the original missing-file failure. */
  function readCheckedHeads() {
    return readFileSync(checkedHeads, 'utf8');
  }
  return { check, readCheckedHeads };
}

/** Record a synthetic board move without claiming that this fixture ran a gate. */
export function submitFixture(board, id, options) {
  return submit(board, id, {
    submissionProof: { version: 1, files: [], full: false, deferred: true,
      reason: 'synthetic board-state fixture; no gate execution' },
    ...options,
  });
}
