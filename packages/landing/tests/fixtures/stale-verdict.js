/** A verified item whose reviewed file main has since changed, on a real repository, for the pulled-landing freshness tests [B3,C7]. */
import * as store from '../../../store/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';

/** A verified item reviewed against the trunk before main moved, on a real repository: main then changes `mainFile`. */
export function verifiedThenMainMoves(t, mainFile) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env });
  repo.put('web/x.js', 'one\n');
  repo.put('web/y.js', 'one\n');
  const trunk = repo.commitAll();
  const builder = cellSeat(board, { lane: 'web', path: repo.root });
  const reviewer = cellSeat(board, { lane: 'tests', path: `${repo.root}/reviewer` });
  const item = cellItem(board, { lane: 'web', title: 'Reviewed change', criterion: 'The page renders.' });
  cellClaim(board, item.item_id, builder, { root: repo.root });
  git('checkout', '-q', '-b', 'item');
  repo.put('web/x.js', 'reviewed change\n');
  const checked = repo.commitAll();
  const tree = git('rev-parse', `${checked}^{tree}`);
  git('checkout', '-q', 'main');
  const held = store.getItem(board, item.item_id);
  submitFixture(board, item.item_id, { agentId: builder.id, commit: checked, tree, files: ['web/x.js'], gateGreen: true, policyCommit: trunk });
  store.reserveReview(board, item.item_id, { agentId: reviewer.id, lane: 'tests', leaseMs: 3_600_000, policy: 'any' });
  store.verify(board, item.item_id, { agentId: reviewer.id, decision: 'ACCEPT', head: checked, digest: held.item_frozen_digest, policy: 'any',
    note: 'Reviewed on a real repository.', review: { commit: checked, head: checked, trunk, paths: ['web/x.js'] } });
  repo.put(mainFile, 'main change\n');
  const main = repo.commitAll();
  return { board, repo, item: item.item_id, main };
}
