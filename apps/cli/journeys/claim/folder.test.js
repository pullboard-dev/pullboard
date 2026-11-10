/** A claim adopts the clean folder an ended or unregistered seat left on the item branch, moving it with its commits [C7]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * Seat web-1 claims an item, commits work in its item folder and releases it; the item branch is then checked out,
 * clean, at `place(box, id, folder)`: an unregistered path or the ended seat's own item folder path. A second web
 * seat then claims the same item.
 *
 * @param {(box: any, id: string, folder: string) => string} place the path that holds the item branch
 * @returns {{ box: any, prior: string, gitDir: string, claim: any }}
 */
function claimWithPriorFolder(place) {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Prior folder', check: 'true', args: ['--specs', 'G1'] });
  const id = String(item.item_id);
  const first = box.run(box.web, 'claim', id);
  assert.equal(first.code, 0, first.err);
  const folder = /item folder: (.+)/u.exec(first.out)?.[1];
  assert.ok(folder, first.out);
  assert.equal(e2e.commitFile(box, folder, 'web/kept.txt', 'kept work\n', 'feat(web): kept prior work [G1]').status, 0);
  const released = box.run(box.web, 'release', id, '--reason', 'BLOCKED', '--note', 'fixture');
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  const prior = place(box, id, folder);
  // The release may already have removed the folder: check the item branch out at the prior path either way.
  if (existsSync(folder) && folder !== prior) {
    try { box.git(box.repo, 'worktree', 'unlock', folder); } catch { /* not locked */ }
    box.git(box.repo, 'worktree', 'move', folder, prior);
  } else if (!existsSync(prior)) {
    box.git(box.repo, 'worktree', 'add', '-q', prior, `web/item-${id}`);
  }
  assert.equal(box.git(prior, 'status', '--porcelain', '--untracked-files=all'), '', 'the prior folder is clean');
  const gitDir = box.git(prior, 'rev-parse', '--absolute-git-dir');
  const web2 = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', web2, '-b', 'web/two');
  const joined = joinFixtureSeat(box, web2, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { box, prior, gitDir, claim: box.run(web2, 'claim', id) };
}

/**
 * Assert the claim moved the prior folder to the new seat's item folder: same Git worktree metadata, the prior path
 * gone, and the committed work present.
 *
 * @param {{ box: any, prior: string, gitDir: string, claim: any }} result
 */
function adopted({ box, prior, gitDir, claim }) {
  const all = `${claim.out}\n${claim.err}`;
  assert.equal(claim.code, 0, all);
  assert.doesNotMatch(all, /ITEM_FOLDER_UNREGISTERED/u);
  const folder = /item folder: (.+)/u.exec(claim.out)?.[1];
  assert.ok(folder && folder !== prior, claim.out);
  assert.equal(existsSync(prior), false, 'the prior path no longer holds a folder');
  assert.equal(box.git(folder, 'rev-parse', '--absolute-git-dir'), gitDir, 'the same worktree was moved, not removed and re-added');
  assert.equal(box.git(folder, 'log', '-1', '--format=%s'), 'feat(web): kept prior work [G1]', 'the commits are kept');
  assert.equal(readFileSync(join(folder, 'web/kept.txt'), 'utf8'), 'kept work\n');
}

test('clause 1: claim moves the clean folder at an unregistered seat path to the new seat path with git worktree move, keeping its commits, instead of refusing ITEM_FOLDER_UNREGISTERED [C7]', () => {
  adopted(claimWithPriorFolder((box, id) => join(box.dir, `nobody-item-${id}`)));
});

test('clause 1: claim moves the clean folder at an ended seat path to the new seat path with git worktree move, keeping its commits, instead of removing and re-adding it [C7]', () => {
  adopted(claimWithPriorFolder((box, id, folder) => folder));
});
