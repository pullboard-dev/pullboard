/** Claim-time spec freshness on real linked Git worktrees [B6,V1]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
const { project } = e2e;

/** Add and commit rows on the coordinator branch. */
function addMainRows(box, ids = ['G3']) {
  const spec = join(box.repo, 'SPEC.md');
  const additions = ids.map((id) => `- ${id} [approved, must] The new row is in force. | gate: test`).join('\n');
  writeFileSync(spec, `${readSpec(box)}\n${additions}\n`);
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: add a spec row [G1]');
}

/** Read the fixture's spec file from its coordinator checkout. */
function readSpec(box) {
  return box.git(box.repo, 'show', 'HEAD:SPEC.md');
}

/** Create a board item whose row is already committed on main. */
function addRowItem(box, ids = 'G3', lane = 'web') {
  const added = box.run(box.repo, 'add', lane, 'Main-only row', '--specs', ids, '--json');
  assert.equal(added.code, 0, added.err || added.out);
  return String(JSON.parse(added.out).item.item_id);
}

/** Commit a local file through the lane's normal hooks. */
function commitLocalWork(box) {
  const file = join(box.web, 'web', 'local.txt');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(file, 'local work\n');
  box.git(box.web, 'add', 'web/local.txt');
  box.git(box.web, 'commit', '-q', '-m', 'docs: local work [G1]');
}

test('a worktree behind main on the spec is caught before UNKNOWN_SPEC [B6, V1]', () => {
  const fastForward = project();
  addMainRows(fastForward);
  const fastForwardItem = addRowItem(fastForward);
  const beforeFastForward = fastForward.git(fastForward.web, 'rev-parse', 'HEAD');
  const built = fastForward.run(fastForward.web, 'next', '--build');
  assert.equal(built.code, 0, built.err || built.out);
  assert.match(built.out, new RegExp(`merged main before claiming #${fastForwardItem}: added spec rows G3`));
  assert.match(built.out, new RegExp(`claimed #${fastForwardItem}`));
  assert.notEqual(beforeFastForward, fastForward.git(fastForward.web, 'rev-parse', 'HEAD'));
  const fastForwardHead = fastForward.git(fastForward.web, 'rev-parse', 'HEAD');
  assert.equal(fastForwardHead, fastForward.git(fastForward.repo, 'rev-parse', 'HEAD'));
  assert.equal(JSON.parse(fastForward.run(fastForward.web, 'show', fastForwardItem, '--json').out).item_claim_head, fastForwardHead);

  const directClaim = project();
  addMainRows(directClaim);
  const directItem = addRowItem(directClaim);
  const direct = directClaim.run(directClaim.web, 'claim', directItem);
  assert.equal(direct.code, 0, direct.err || direct.out);
  assert.match(direct.out, new RegExp(`merged main before claiming #${directItem}: added spec rows G3`));
  assert.match(direct.out, new RegExp(`claimed #${directItem}`));
  const directHead = directClaim.git(directClaim.web, 'rev-parse', 'HEAD');
  assert.equal(directHead, directClaim.git(directClaim.repo, 'rev-parse', 'HEAD'));
  assert.equal(JSON.parse(directClaim.run(directClaim.web, 'show', directItem, '--json').out).item_claim_head, directHead);

  const localCommit = project();
  addMainRows(localCommit, ['G3', 'G4']);
  const localItem = addRowItem(localCommit, 'G3,G4');
  commitLocalWork(localCommit);
  const localHead = localCommit.git(localCommit.web, 'rev-parse', 'HEAD');
  const refused = localCommit.run(localCommit.web, 'claim', localItem);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^(?:stderr: )?pullboard: \[SPEC_BEHIND_MAIN\]/mu);
  assert.match(refused.err, /G3, G4/u);
  assert.ok(refused.err.trimEnd().endsWith('next: git merge main'));
  const refusalJson = JSON.parse(localCommit.run(localCommit.web, 'claim', localItem, '--json').out);
  assert.equal(refusalJson.error.code, 'SPEC_BEHIND_MAIN');
  assert.equal(refusalJson.error.next, 'git merge main');
  assert.equal(localCommit.git(localCommit.web, 'rev-parse', 'HEAD'), localHead);
  assert.match(localCommit.run(localCommit.repo, 'list', '--all').out, new RegExp(`#${localItem}  open`));

  const untracked = project();
  addMainRows(untracked);
  const untrackedItem = addRowItem(untracked);
  mkdirSync(join(untracked.web, 'web'), { recursive: true });
  writeFileSync(join(untracked.web, 'web', 'untracked.txt'), 'uncommitted work\n');
  const untrackedHead = untracked.git(untracked.web, 'rev-parse', 'HEAD');
  const untrackedRefusal = untracked.run(untracked.web, 'claim', untrackedItem);
  assert.equal(untrackedRefusal.code, 1);
  assert.match(untrackedRefusal.err, /^(?:stderr: )?pullboard: \[SPEC_BEHIND_MAIN\]/mu);
  assert.match(untrackedRefusal.err, /G3/u);
  assert.ok(untrackedRefusal.err.trimEnd().endsWith('next: git merge main'));
  assert.equal(untracked.git(untracked.web, 'rev-parse', 'HEAD'), untrackedHead);

  const dirty = project();
  addMainRows(dirty);
  const dirtyItem = addRowItem(dirty);
  const dirtyPath = join(dirty.web, 'AGENTS.md');
  const dirtyText = readFileSync(dirtyPath, 'utf8') + '\nLocal unfinished instructions.\n';
  writeFileSync(dirtyPath, dirtyText);
  const dirtyHead = dirty.git(dirty.web, 'rev-parse', 'HEAD');
  const dirtyRefusal = dirty.run(dirty.web, 'next', '--build');
  assert.equal(dirtyRefusal.code, 1);
  assert.match(dirtyRefusal.err, /^(?:stderr: )?pullboard: \[SPEC_BEHIND_MAIN\]/mu);
  assert.ok(dirtyRefusal.err.trimEnd().endsWith('next: git merge main'));
  assert.equal(dirty.git(dirty.web, 'rev-parse', 'HEAD'), dirtyHead);
  assert.equal(readFileSync(dirtyPath, 'utf8'), dirtyText);
  assert.equal(JSON.parse(dirty.run(dirty.repo, 'show', dirtyItem, '--json').out).item_status, 'open');

  // Earlier claim guards keep their refusal and cannot advance a caller in the wrong lane.
  const wrongLane = project();
  addMainRows(wrongLane);
  const wrongItem = addRowItem(wrongLane, 'G3', 'api');
  const wrongHead = wrongLane.git(wrongLane.web, 'rev-parse', 'HEAD');
  const wrong = wrongLane.run(wrongLane.web, 'claim', wrongItem);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /^(?:stderr: )?pullboard: \[WRONG_LANE\]/mu);
  assert.equal(wrongLane.git(wrongLane.web, 'rev-parse', 'HEAD'), wrongHead);

  const alreadyCurrent = project();
  addMainRows(alreadyCurrent);
  const currentItem = addRowItem(alreadyCurrent);
  alreadyCurrent.git(alreadyCurrent.web, 'merge', '--ff-only', 'main');
  const currentHead = alreadyCurrent.git(alreadyCurrent.web, 'rev-parse', 'HEAD');
  const claimed = alreadyCurrent.run(alreadyCurrent.web, 'claim', currentItem);
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  assert.match(claimed.out, new RegExp(`claimed #${currentItem}`));
  assert.doesNotMatch(claimed.out, /merged main/u);
  assert.equal(alreadyCurrent.git(alreadyCurrent.web, 'rev-parse', 'HEAD'), currentHead);
});

test.after(e2e.cleanup);
