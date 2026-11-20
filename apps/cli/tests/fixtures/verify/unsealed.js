/** Shared verify journey helpers: read a JSON CLI answer and record an unsealed submit [C7,V4]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from "../../../../../packages/store/index.js";
import { openKitBoard as openBoard } from "../../../../lib/tests/fixtures/board.js";
import { submitFixture } from "../board/submit.js";

/** Read a successful JSON CLI response; setup failures must not masquerade as eligibility failures. */
export function document(result) {
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

/**
 * Record the builder's submit as a board move with no sealed gate proof. verify then has no submit proof to reuse and runs
 * the armed frozen check itself; the cases below observe that run [C7,V4].
 */
export async function submitUnsealed(box) {
  // @pullboard-board-file journey: share the board file the real verify command reads
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    submitFixture(board, 1, { agentId: document(await box.runIn(box.web, 'whoami', '--json')).id,
      commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      policyCommit: box.git(box.repo, 'rev-parse', 'main') });
  } finally {
    store.closeBoard(board);
  }
}
