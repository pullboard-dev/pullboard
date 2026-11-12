/** Real claim and release lifecycle for isolated item worktrees [B5,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('[B5,C7] claim opens a folder; release removes a clean folder and the next claim reuses its branch', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'item folder fixture', '--criterion', 'The item is isolated', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  assert.ok(path && existsSync(path), 'claim prints a real folder');
  assert.equal(box.git(path, 'branch', '--show-current'), `web/item-${id}`);
  assert.equal(box.git(path, 'rev-parse', 'HEAD'), box.git(box.repo, 'rev-parse', 'main'));
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'exercise reuse', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);
  assert.equal(existsSync(path), false, 'release removes the clean item folder');
  assert.equal(box.git(box.repo, 'rev-parse', `refs/heads/web/item-${id}`), box.git(box.repo, 'rev-parse', 'main'), 'release retains the branch');
  const again = await box.runLocal(box.web, 'claim', String(id));
  assert.equal(again.code, 0, again.err || again.out);
  assert.ok(again.out.includes(`item folder: ${path}`), 'text output names the reused folder');
  writeFileSync(join(path, 'uncommitted.txt'), 'preserve me\n');
  const dirty = await box.runLocal(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'retain dirty work', '--no-next');
  assert.equal(dirty.code, 0, dirty.err || dirty.out);
  assert.equal(existsSync(join(path, 'uncommitted.txt')), true, 'uncommitted work prevents cleanup');
  unlinkSync(join(path, 'uncommitted.txt'));
  await box.runLocal(box.web, 'next', '--verify', '--no-next');
  assert.equal(existsSync(path), false, 'next removes the released folder once its work is clean');
  assert.ok(box.git(box.repo, 'rev-parse', `refs/heads/web/item-${id}`), 'next retains the released branch');
});

test('[B5,C7] a new item folder starts at the current main with an empty index after main moves', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'item folder follows main fixture', '--criterion', 'The item is isolated', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;

  writeFileSync(join(box.repo, 'main-moved.txt'), 'main advanced after item creation\n');
  box.git(box.repo, 'add', 'main-moved.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main before item claim');
  const main = box.git(box.repo, 'rev-parse', 'main');

  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  const path = JSON.parse(claimed.out).itemFolder;
  assert.equal(box.git(path, 'rev-parse', 'HEAD'), main, 'the folder starts at the moved main');
  assert.equal(box.git(path, 'status', '--porcelain'), '', 'the new folder has an empty index and worktree');
});

test('[B5,C7] claim refuses a dirty reused folder and names files that are not in the item', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'dirty reused folder fixture', '--criterion', 'The item is isolated', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  writeFileSync(join(path, 'stray.txt'), 'unrelated staged-folder content\n');
  box.git(path, 'add', 'stray.txt');
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'retain dirty folder', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);

  const reclaimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.notEqual(reclaimed.code, 0, reclaimed.out);
  const refusal = JSON.parse(reclaimed.out);
  assert.equal(refusal.error.code, 'ITEM_FOLDER_DIRTY');
  assert.match(refusal.error.message, /stray\.txt/u);
  assert.equal(existsSync(join(path, 'stray.txt')), true, 'the refused folder remains intact');
  assert.match((await box.runLocal(box.repo, 'show', String(id))).out, new RegExp(`^#${id}\\s+open\\b`, 'mu'), 'refused before the move: the item was never claimed (#5766)');
});

test('[B5,C7] a same-holder claim renewal preserves uncommitted item work', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'renew a dirty item folder', '--criterion', 'A claim renewal preserves item work', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  writeFileSync(join(path, 'README.md'), 'uncommitted item work\n');

  const renewed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(renewed.code, 0, renewed.err || renewed.out);
  assert.equal(JSON.parse(renewed.out).renewed, true);
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'uncommitted item work\n');

  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'preserve dirty item work', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);
  const reclaimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.notEqual(reclaimed.code, 0, reclaimed.out);
  const refusal = JSON.parse(reclaimed.out);
  assert.equal(refusal.error.code, 'ITEM_FOLDER_DIRTY');
  assert.match(refusal.error.message, /README\.md/u);
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'uncommitted item work\n');
});

test('[B5,C7] an ignored cache does not make a reused item folder dirty', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  writeFileSync(join(box.repo, '.gitignore'), 'cache/\n');
  box.git(box.repo, 'add', '.gitignore');
  box.git(box.repo, 'commit', '-q', '-m', 'test: ignore generated cache');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'ignore generated item folder files', '--criterion', 'Ignored cache files do not block reuse', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  mkdirSync(join(path, 'cache'));
  writeFileSync(join(path, 'cache', 'generated.txt'), 'generated\n');
  const released = await box.runLocal(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'reuse ignored generated files', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);

  const reclaimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(reclaimed.code, 0, reclaimed.err || reclaimed.out);
  assert.equal(JSON.parse(reclaimed.out).itemFolder, path);
  assert.equal(readFileSync(join(path, 'cache', 'generated.txt'), 'utf8'), 'generated\n');
});


/** Leave exactly the old native item folder a later seat must recover. */
async function priorItemFolder(t) {
  const box = crossLaneFixture(t);
  const old = box.seat('folder-old', 'web', 'folder-old-session');
  const next = box.seat('folder-next', 'web', 'folder-next-session');
  const id = box.add('web', 'Recover the previous item folder');
  const claimed = box.json(await box.runAsLocal('folder-old-session', old.root, 'claim', String(id), '--json'));
  const path = claimed.itemFolder;
  const claimNext = () => box.runAsLocal('folder-next-session', next.root, 'claim', String(id), '--json');
  const releaseOld = () => box.runAsLocal('folder-old-session', old.root, 'release', String(id), '--reason', 'OTHER', '--note', 'The next seat continues the same item', '--no-next');
  return { box, old, next, id, path, claimNext, releaseOld };
}

test('a claim takes over an old clean item folder without manual Git cleanup [B5,C7]', async t => {
  const { box, id, path, claimNext, releaseOld } = await priorItemFolder(t);
  writeFileSync(join(path, 'old-draft.txt'), 'leave this folder during release\n');
  const released = await releaseOld();
  assert.equal(released.code, 0, released.err || released.out);
  unlinkSync(join(path, 'old-draft.txt'));
  assert.equal(existsSync(path), true, 'the previous native folder still holds the branch');
  const taken = await claimNext();
  assert.equal(taken.code, 0, taken.err || taken.out);
  const current = JSON.parse(taken.out).itemFolder;
  assert.notEqual(current, path);
  assert.equal(existsSync(path), false);
  assert.equal(box.git(current, 'branch', '--show-current'), `web/item-${id}`);
});

test('taking over a dirty item folder archives its exact work before removal [B5,C7]', async t => {
  const { box, id, path, claimNext, releaseOld } = await priorItemFolder(t);
  const head = box.git(path, 'rev-parse', 'HEAD');
  writeFileSync(join(path, 'README.md'), 'staged item draft\n');
  box.git(path, 'add', 'README.md');
  writeFileSync(join(path, 'private-draft.txt'), 'untracked item draft\n');
  const released = await releaseOld();
  assert.equal(released.code, 0, released.err || released.out);
  const taken = await claimNext();
  assert.equal(taken.code, 0, taken.err || taken.out);
  assert.equal(existsSync(path), false);
  const shown = box.json(await box.runLocal(box.repo, 'show', String(id), '--json'));
  const note = shown.thread.find(row => row.type === 'fact' && row.text.startsWith('Archived prior item folder '));
  assert.ok(note, 'the item retains a native recovery note');
  const recovery = JSON.parse(note.text.split('\nRecovery: ')[1]);
  assert.ok(recovery.directory, 'the note locates the verified archive');
  const manifest = JSON.parse(readFileSync(join(recovery.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.head, head);
  assert.equal(box.git(box.repo, 'rev-parse', manifest.ref), head);
  assert.match(readFileSync(join(recovery.directory, 'staged.patch'), 'utf8'), /staged item draft/u);
  const untracked = manifest.files.find(file => file.path === 'private-draft.txt');
  assert.ok(untracked, 'untracked draft bytes remain recoverable');
  assert.equal(readFileSync(join(recovery.directory, 'blobs', untracked.sha256), 'utf8'), 'untracked item draft\n');
});

test('a still-held item folder is retained and the claim names its holder [B5,C7]', async t => {
  const { box, old, id, path, claimNext } = await priorItemFolder(t);
  const before = box.git(path, 'rev-parse', 'HEAD');
  const refused = await claimNext();
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'HELD');
  assert.ok(error.message.includes(old.agent));
  assert.equal(existsSync(path), true);
  assert.equal(box.git(path, 'rev-parse', 'HEAD'), before);
  const shown = box.json(await box.runLocal(box.repo, 'show', String(id), '--json'));
  assert.equal(shown.item_owner, old.agent);
});

test('board commands run inside a seat\'s item folder act as that seat and next never opens a new seat [B5,C7]', async t => {
  const box = crossLaneFixture(t);
  const web = box.seat('folder-seat', 'web', box.session);
  const first = box.add('web', 'First item in its own folder');
  const second = box.add('web', 'Second item claimed from the first folder');
  const folder = box.json(await box.runAsLocal(box.session, web.root, 'claim', String(first), '--json')).itemFolder;
  const folders = () => box.git(box.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length;
  const seats = async () => box.json(await box.runLocal(box.repo, 'seats', '--json')).seats.map(row => row.seat).sort();
  const [foldersBefore, seatsBefore] = [folders(), await seats()];
  for (const args of [['status'], ['inbox'], ['show', String(first)]]) box.json(await box.runAsLocal(box.session, folder, ...args, '--json'));
  box.json(await box.runAsLocal(box.session, folder, 'shout', 'web', 'from the item folder', '--json'));
  const next = await box.runAsLocal(box.session, folder, 'next', '--build', '--json');
  assert.equal(next.code, 0, next.out + next.err);
  assert.deepEqual(await seats(), seatsBefore, 'running next from the item folder never joins a new seat');
  assert.equal(box.json(await box.runLocal(box.repo, 'show', String(first), '--json')).item_owner, web.agent, 'next resumes the folder\'s own held item');
  assert.equal(folders(), foldersBefore, 'resuming opens no folder');
  const claimed = box.json(await box.runAsLocal(box.session, folder, 'claim', String(second), '--json'));
  assert.equal(claimed.itemFolder, `${web.root}-item-${second}`);
  assert.equal(box.json(await box.runLocal(box.repo, 'show', String(second), '--json')).item_owner, web.agent, 'the folder\'s seat claims the second item');
  assert.deepEqual(await seats(), seatsBefore, 'claiming from the item folder never joins a new seat');
  assert.ok(existsSync(`${web.root}-item-${second}`), 'the new folder opens beside the seat, not inside the item folder');
});
