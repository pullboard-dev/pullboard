/** Record a lifecycle journey's submissions and verdicts through the real board moves, with no gate job [C7]. */
import { join } from 'node:path';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import * as store from '../../../../../packages/store/index.js';
import { withFixtureBoard } from '../board.js';
import { submitFixture } from './submit.js';

/**
 * Run one synchronous write on the checkout's board file through the kit seam, closing it so the next CLI command owns it.
 * @param {{ root: string, git: Function }} box - A fixture project whose git(cwd, ...args) returns trimmed output.
 * @param {(board: object) => any} write - The one write.
 * @returns {any} What write returned.
 */
function withBoard(box, write) {
  const common = box.git(box.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return withFixtureBoard(join(common, 'pullboard', 'board.sqlite'), write);
}

/** Record a claimed item's submission of one commit, as the holder, without running a gate: a case that reads stale-bar diagnostics needs the state, not a gate [C7]. */
export function recordFixtureSubmission(box, id, { commit, tree }) {
  withBoard(box, (board) => submitFixture(board, id, { agentId: store.getItem(board, id).item_owner, commit, tree }));
}

/** Record the coordinator's accepting verdict on a submitted commit through the real verify move. */
export function recordFixtureAcceptance(box, id, commit, note) {
  withBoard(box, (board) => store.verify(board, id, {
    agentId: COORDINATOR, decision: 'ACCEPT', reason: store.ACCEPT_REASON, note,
    head: commit, digest: store.getItem(board, id).item_frozen_digest, policy: 'any',
  }));
}
