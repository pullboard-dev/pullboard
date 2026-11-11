/** Accepted policy changes never touch a real claim's frozen bar; policy is read live per move [#2471,B4]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { openBoard } from '../../../../lib/index.js';
import { writeBoardCommand } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

/** Open the fixture's real SQLite board and close it with the test. */
function boardFor(t, repo) {
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: repo });
  t.after(() => store.closeBoard(board));
  return board;
}

/** Change accepted config on main so an item worktree sees the new policy source. */
function commitPolicy(box, repo, change) {
  const path = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  change(config);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  box.git(repo, 'add', 'pullboard.json');
  box.git(repo, 'commit', '-q', '-m', 'chore: update accepted policy');
}

/** Add an ordinary checked item to the fixture board. */
function addPolicyItem(board, title) {
  return store.addItem(board, { by: COORDINATOR, lane: 'web', title, specIds: ['G1'], criterion: 'The page renders.',
    check: 'true', brief: 'Files: web/feature.js\nTest: the frozen check passes.' });
}

test('an unrelated accepted policy change keeps a real re-claim\'s bar digest, so a queued submit matches it [B4,V2,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = boardFor(t, box.repo);
  const id = addPolicyItem(board, 'Unrelated policy refresh');
  const firstClaim = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(firstClaim.code, 0, firstClaim.out + firstClaim.err);
  const before = store.getItem(board, id);
  assert.equal(JSON.parse(before.item_frozen).policy, undefined, 'a new freeze holds the bar alone');
  store.release(board, id, 'web-1', 'fixture release', undefined, 'OTHER');

  commitPolicy(box, box.repo, config => {
    config.landing.manualOverride = !config.landing.manualOverride;
  });
  const nextClaim = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(nextClaim.code, 0, nextClaim.out + nextClaim.err);

  const after = store.getItem(board, id);
  assert.equal(after.item_status, 'claimed');
  assert.equal(after.item_frozen_digest, before.item_frozen_digest, 'a policy commit is not a bar change');
  assert.equal(after.item_frozen, before.item_frozen);

  const folder = JSON.parse(nextClaim.out).itemFolder;
  assert.ok(folder, 'the real claim returned its machine-created item folder');
  const committed = helpers.commitFile(box, folder, 'web/feature.js', 'export const ready = true;\n', 'feat(web): preserve queued policy work [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  const commit = box.git(folder, 'rev-parse', 'HEAD');
  const options = { agentId: after.item_owner, job: randomUUID(), main: box.git(box.repo, 'rev-parse', 'main'),
    commit, tree: box.git(folder, 'rev-parse', 'HEAD^{tree}'), executionCommit: commit,
    executionTree: box.git(folder, 'rev-parse', 'HEAD^{tree}'), digest: after.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 };
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [id, options], after.item_owner);
  assert.equal(queued.created, true);
  assert.equal(queued.job.digest, after.item_frozen_digest);
});

test('a change to this item lane policy re-claims with the same bar digest, never NO_POLICY [B4,V2,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = boardFor(t, box.repo);
  const id = addPolicyItem(board, 'Lane policy change');
  assert.equal(box.run(box.web, 'claim', String(id), '--json').code, 0);
  const before = store.getItem(board, id);
  store.release(board, id, 'web-1', 'fixture release', undefined, 'OTHER');
  commitPolicy(box, box.repo, config => { config.lanes.web.owns = ['web/', 'test/']; });

  const result = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(result.code, 0, result.out + result.err);
  assert.doesNotMatch(result.out + result.err, /NO_POLICY/u);
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  assert.equal(store.getItem(board, id).item_frozen_digest, before.item_frozen_digest);
});

test('clause 2: a submit already queued survives an unrelated accepted policy change and a lane change still refuses with its key [B4,V2,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = boardFor(t, box.repo);
  const id = addPolicyItem(board, 'Queued before policy change');
  const claim = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.out + claim.err);
  const folder = JSON.parse(claim.out).itemFolder;
  const committed = helpers.commitFile(box, folder, 'web/feature.js', 'export const ready = true;\n', 'feat(web): queued before policy change [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  const item = store.getItem(board, id);
  const commit = box.git(folder, 'rev-parse', 'HEAD');
  const tree = box.git(folder, 'rev-parse', 'HEAD^{tree}');
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [id, { agentId: item.item_owner, job: randomUUID(),
    main: box.git(box.repo, 'rev-parse', 'main'), commit, tree, executionCommit: commit, executionTree: tree,
    digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], item.item_owner);
  commitPolicy(box, box.repo, config => { config.landing.manualOverride = !config.landing.manualOverride; });
  const started = writeBoardCommand(board, 'startSubmitHandoff', [id, { agentId: item.item_owner, job: queued.job.id }], item.item_owner);
  assert.equal(started.job.id, queued.job.id, 'the already queued job is still the board\'s job after the policy change');
  assert.notEqual(started.job.state, 'red');
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  assert.equal(store.getItem(board, id).item_frozen_digest, item.item_frozen_digest, 'the bar did not bounce');
});
