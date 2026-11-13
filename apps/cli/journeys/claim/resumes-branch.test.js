/** A reopened item's next claim starts from its earlier builder's branch merged with main; a conflict names its files [C7,#2906]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/**
 * File an item, claim it, commit `file` on its branch as the earlier builder, release it, then move main with `mainText` in `mainFile`.
 * @returns {Promise<{ box: any, id: number, path: string, own: string, main: string }>}
 */
async function reopenedItem(t, file, mainFile, mainText) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'claim resumes the earlier branch fixture', '--criterion', 'The claim resumes the branch', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  assert.ok(path && existsSync(path), 'claim prints a real folder');

  writeFileSync(join(path, file), 'the earlier builder\'s line\n');
  box.git(path, 'add', file);
  const own = box.git(path, 'commit-tree', box.git(path, 'write-tree'), '-p', 'HEAD', '-m', 'feat(web): the earlier builder\'s commit [G1]');
  box.git(path, 'update-ref', 'HEAD', own);
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'BLOCKED', '--note', 'Private fixture: reopen the item.', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);

  writeFileSync(join(box.repo, mainFile), mainText);
  box.git(box.repo, 'add', mainFile);
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main after the earlier builder');
  return { box, id, path, own, main: box.git(box.repo, 'rev-parse', 'main') };
}

test('clause 1: claiming a reopened item creates its folder on the earlier branch head merged with main, with no seat action [C7]', async t => {
  const { box, id, path, own, main } = await reopenedItem(t, 'builder.txt', 'main-moved.txt', 'main\'s unrelated file\n');
  const reclaimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(reclaimed.code, 0, reclaimed.err || reclaimed.out);
  assert.equal(JSON.parse(reclaimed.out).itemFolder, path, 'the claim opens the earlier builder\'s folder');
  assert.doesNotThrow(() => box.git(path, 'merge-base', '--is-ancestor', own, 'HEAD'), 'the earlier builder\'s commit is kept');
  assert.doesNotThrow(() => box.git(path, 'merge-base', '--is-ancestor', main, 'HEAD'), 'main is merged in');
  assert.equal(box.git(path, 'status', '--porcelain'), '', 'a clean merge leaves nothing for the seat to do');
});

test('clause 2: a conflicting merge with main names the conflicting files and leaves the branch as it was [C7]', async t => {
  const { box, id, path, own } = await reopenedItem(t, 'shared.txt', 'shared.txt', 'main\'s different line\n');
  const reclaimed = await box.runLocal(box.web, 'claim', String(id));
  assert.equal(reclaimed.code, 0, reclaimed.err || reclaimed.out);
  assert.match(reclaimed.out, /conflicts in shared\.txt/u, 'the claim names the conflicting file');
  assert.equal(box.git(path, 'rev-parse', 'HEAD'), own, 'the branch keeps the earlier builder\'s head');
  assert.equal(box.git(path, 'status', '--porcelain'), '', 'no half-done merge is left in the folder');
});
