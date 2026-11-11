/** Submit, verify and land read policy live and record its version; the reviewer-family rule is pinned per submit [B4,R2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { policyAt } from '../../../../../packages/sandbox/index.js';
import { policyVersion } from '../../../../../packages/sandbox/index.js';
import { frozenFamilyPolicy } from '../../../../../packages/store/src/io/relaxation.js';
import { replayArgs } from '../../../../../packages/state/src/logic/engine/move/verify.js';
import { openKitBoard } from '../../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

/** Commit a policy change to main's pullboard.json, as the coordinator does, and return the new main. */
function changePolicy(box, change) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  change(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: change policy');
  return box.git(box.repo, 'rev-parse', 'HEAD');
}

/** Read the board through a short-lived native connection. */
function onBoard(box, read) {
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try { return read(board); } finally { store.closeBoard(board); }
}

/** The details of one item's events of a kind, oldest first. */
function details(board, kind, id) {
  return store.eventsOfKinds(board, [kind]).filter(row => id === undefined || row.item_id === id).map(row => JSON.parse(row.event_detail));
}

/** The version a move must record for the policy at a commit. */
function versionAt(box, commit) {
  const { commit: at, digest } = policyVersion(policyAt(box.repo, commit));
  return { commit: at, digest };
}

test('clause 1: submit, verify and land read the policy live after a policy commit and record its commit and digest [B4,R2]', { timeout: 300_000 }, // budget: one real submit, accept and landing; hang ceiling only.
() => {
  const box = landProject();
  const entry = itemWorktree(box, 1);
  const claimBase = box.git(box.repo, 'rev-parse', 'main');
  const live = changePolicy(box, config => { config.lanes.ops = { owns: ['ops/'], specs: [] }; });
  assert.notEqual(live, claimBase, 'the policy moved after the claim');
  box.git(entry.path, 'merge', '-q', '--ff-only', 'main');
  submitItem(box, entry);
  acceptItem(box, entry);
  const landed = box.run(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.out + landed.err);
  assert.deepEqual(JSON.parse(landed.out).landed, [entry.item]);
  onBoard(box, board => {
    const expected = versionAt(box, live);
    assert.equal(expected.commit, live);
    assert.deepEqual(details(board, 'submit', entry.item).at(-1).policy, expected, 'the submit event records the live policy version');
    assert.deepEqual(details(board, 'accept', entry.item).at(-1).policy, expected, 'the verdict event records the live policy version');
    const batches = details(board, 'landing_batch').map(detail => detail.batch).filter(batch => batch.items.some(item => item.id === entry.item));
    assert.ok(batches.length, 'the landing recorded its batch');
    assert.deepEqual(batches.at(-1).policy, versionAt(box, batches.at(-1).base), 'the landing event records the policy at its base');
    assert.equal(batches.at(-1).policy.commit, live);
    assert.notDeepEqual(expected, versionAt(box, claimBase), 'a claim-time policy would have recorded a different version');
  });
});

test('clause 2: the reviewer-family rule is pinned at submit, so a policy change mid-review applies only to the next submit [B4,R2]', { timeout: 300_000 }, // budget: two real submits; hang ceiling only.
() => {
  const box = landProject();
  const first = itemWorktree(box, 1);
  submitItem(box, first);
  const pinned = onBoard(box, board => store.getItem(board, first.item));
  assert.equal(JSON.parse(pinned.item_verify_policy).verify.family, 'off', 'the submit pinned the family rule it was judged under');
  changePolicy(box, config => { config.verify = { policy: 'any', family: 'prefer' }; });
  assert.equal(mainPolicy(box.repo).config.verify.family, 'prefer', 'live policy now prefers a different family');
  onBoard(box, board => {
    const item = store.getItem(board, first.item);
    assert.equal(frozenFamilyPolicy(item, 'require'), 'off', 'the in-flight review keeps its submit-time rule');
    const args = [first.item, { agentId: 'reviewer', decision: 'ACCEPT', policy: 'any', familyPolicy: 'prefer' }];
    replayArgs(board, args, { move: { id: 'move-mid-review' }, store });
    assert.equal(args[1].familyPolicy, 'off', 'replay re-judges with the pinned rule, not the verdict\'s live one');
  });
  const second = itemWorktree(box, 2);
  submitItem(box, second);
  onBoard(box, board => {
    const item = store.getItem(board, second.item);
    assert.equal(JSON.parse(item.item_verify_policy).verify.family, 'prefer', 'the next submit pins the changed rule');
    assert.equal(frozenFamilyPolicy(item, 'off'), 'prefer');
  });
});
