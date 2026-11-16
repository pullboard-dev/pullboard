/** @pullboard-test-input packages/landing/src/io/land/hand.js */
/** landOneByHand merges one accepted item through the landing job's merge step and records the reason and the bypassed hold [C7,#3775]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landOneByHand } from '../../../src/io/land/hand.js';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

const COORDINATOR_ID = 'coordinator';
const HELD = [{ item: 9001, status: 'open', test: 'packages/x/tests/a.test.js' }];

/** A verified item on a real repository whose trunk a test defect holds; main has not moved since the review. */
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

test('clause 1: landOneByHand merges the accepted item onto main and records the item as landed [C7,#3775]', t => {
  const { board, repo, id, checked, git } = acceptedItem(t);
  const landed = landOneByHand(board, id, { root: repo.root, reason: 'trunk defect #9001 is unrelated to this item', held: HELD, agentId: COORDINATOR_ID });
  assert.equal(git('rev-parse', 'main'), landed.commit, 'main moved to the merge commit');
  assert.equal(git('rev-parse', `${landed.commit}^2`), checked, 'the merge is the landing job\'s --no-ff merge of the accepted commit');
  assert.equal(store.getItem(board, id).item_merged_commit, landed.commit);
});

test('clause 2: the landed record carries the reason and names the bypassed hold [C7,#3775]', t => {
  const { board, repo, id } = acceptedItem(t);
  landOneByHand(board, id, { root: repo.root, reason: 'trunk defect #9001 is unrelated to this item', held: HELD, agentId: COORDINATOR_ID });
  const event = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='merged' AND item_id=? ORDER BY event_id DESC").get(id);
  const note = JSON.parse(event.event_detail).note;
  assert.match(note, /trunk defect #9001 is unrelated to this item/u);
  assert.match(note, /bypassed hold: this trunk is held by #9001 \(open; packages\/x\/tests\/a\.test\.js\)/u);
});

test('clause 2: a landing with no reason or no hold to bypass refuses and writes nothing [C7,#3775]', t => {
  const { board, repo, id } = acceptedItem(t);
  assert.throws(() => landOneByHand(board, id, { root: repo.root, reason: ' ', held: HELD, agentId: COORDINATOR_ID }), { code: 'HAND_REASON' });
  assert.throws(() => landOneByHand(board, id, { root: repo.root, reason: 'why', held: [], agentId: COORDINATOR_ID }), { code: 'NOT_HELD' });
  assert.equal(store.getItem(board, id).item_merged_commit, null);
});
