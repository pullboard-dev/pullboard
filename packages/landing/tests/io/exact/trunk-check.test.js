/** @pullboard-test-input packages/landing/src/io/land/hand.js */
/** With landing.exactTreeCheck on, a hand landing refuses a merged tree with no green exact-tree record and leaves the branch where it started: RFC 0011 ET5, approved 17 Nov 2026 [V16,V36]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landOneByHand } from '../../../src/io/land/hand.js';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

const COORDINATOR_ID = 'coordinator';
const HELD = [{ item: 9001, status: 'open', test: 'packages/x/tests/a.test.js' }];

/** A verified item on a real repository whose trunk a test defect holds; main has not moved since the review (the hand test's own setup). */
function acceptedItem(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env });
  repo.put('web/x.js', 'one\n');
  const trunk = repo.commitAll();
  const builder = cellSeat(board, { lane: 'web', path: repo.root });
  const reviewer = cellSeat(board, { lane: 'tests', path: `${repo.root}/reviewer` });
  const item = cellItem(board, { lane: 'web', title: 'Held change', criterion: 'The page renders.' });
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
  return { board, repo, id: item.item_id, checked, git };
}


const OPTIONS = { reason: 'trunk defect #9001 is unrelated to this item', held: HELD, agentId: COORDINATOR_ID };

test('landing.exact.trunk-check-refuses-unproved-hand: clause 1: with exactTreeCheck on, landOneByHand refuses a merged tree with no green exact-tree record, names the tree id and leaves the branch at the commit it started from [V16,V36]', t => {
  const { board, repo, id, git } = acceptedItem(t);
  const started = git('rev-parse', 'main');
  let refusal;
  assert.throws(() => landOneByHand(board, id, { ...OPTIONS, root: repo.root, exactTreeCheck: true }), error => { refusal = error; return error.code === 'LAND_EXACT_TREE'; });
  const tree = /tree ([a-f0-9]{40,64})/u.exec(refusal.message)?.[1];
  assert.ok(tree, 'the refusal names the tree id');
  assert.equal(git('rev-parse', 'main'), started, 'the branch is back at the commit it started from');
  assert.equal(store.getItem(board, id).item_merged_commit, null, 'nothing is recorded as landed');
  // A batch holding a green record for exactly that tree lets the same landing through, and a red one does not.
  const batch = result => ({ version: 1, id: `batch-${result}`, state: 'ready', base: started, tip: started, branch: 'refs/heads/main', root: repo.root, owner: 'fixture',
    logPath: '/dev/null', candidates: [], items: [], revision: 0, exactTree: { tree, pin: 'tooling', cells: ['web'], result } });
  store.recordLandingBatch(board, { agentId: COORDINATOR_ID, batch: batch('red') });
  assert.throws(() => landOneByHand(board, id, { ...OPTIONS, root: repo.root, exactTreeCheck: true }), { code: 'LAND_EXACT_TREE' });
  store.recordLandingBatch(board, { agentId: COORDINATOR_ID, batch: batch('green') });
  const landed = landOneByHand(board, id, { ...OPTIONS, root: repo.root, exactTreeCheck: true });
  assert.equal(git('rev-parse', 'main'), landed.commit);
  assert.equal(git('rev-parse', `${landed.commit}^{tree}`), tree, 'main points to the proved tree');
});

test('landing.exact.trunk-check-off-lands-as-today: clause 2: with exactTreeCheck off or not given, landOneByHand lands as it does today [V16,V36]', t => {
  for (const extra of [{}, { exactTreeCheck: false }]) {
    const { board, repo, id, git } = acceptedItem(t);
    const landed = landOneByHand(board, id, { ...OPTIONS, root: repo.root, ...extra });
    assert.equal(git('rev-parse', 'main'), landed.commit);
    assert.equal(store.getItem(board, id).item_merged_commit, landed.commit);
  }
});
