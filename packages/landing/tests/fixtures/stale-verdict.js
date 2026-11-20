/** A verified item whose reviewed file main has since changed, on a real repository, for the pulled-landing freshness tests [B3,C7]. */
import * as store from '../../../store/index.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';

/** A verified item reviewed against the trunk before main moved, on a real repository: main then changes `mainFile`; the calling test passes in the board opener (cellBoard from the board cell fixture); `shape` names the reviewed file and its three contents (base, reviewed, main's). */
export function verifiedThenMainMoves(t, mainFile, cellBoard, { file = 'web/x.js', base = 'one\n', reviewed = 'reviewed change\n', changed = 'main change\n' } = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env });
  repo.put(file, base);
  repo.put('web/y.js', 'one\n');
  const trunk = repo.commitAll();
  const builder = cellSeat(board, { lane: 'web', path: repo.root });
  const reviewer = cellSeat(board, { lane: 'tests', path: `${repo.root}/reviewer` });
  const item = cellItem(board, { lane: 'web', title: 'Reviewed change', criterion: 'The page renders.' });
  cellClaim(board, item.item_id, builder, { root: repo.root });
  git('checkout', '-q', '-b', 'item');
  repo.put(file, reviewed);
  const checked = repo.commitAll();
  const tree = git('rev-parse', `${checked}^{tree}`);
  git('checkout', '-q', 'main');
  const held = store.getItem(board, item.item_id);
  submitFixture(board, item.item_id, { agentId: builder.id, commit: checked, tree, files: [file], gateGreen: true, policyCommit: trunk });
  store.reserveReview(board, item.item_id, { agentId: reviewer.id, lane: 'tests', leaseMs: 3_600_000, policy: 'any' });
  store.verify(board, item.item_id, { agentId: reviewer.id, decision: 'ACCEPT', head: checked, digest: held.item_frozen_digest, policy: 'any',
    note: 'Reviewed on a real repository.', review: { commit: checked, head: checked, trunk, paths: [file] } });
  repo.put(mainFile, changed);
  const main = repo.commitAll();
  return { board, repo, item: item.item_id, main };
}
