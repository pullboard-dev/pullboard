/** Plain companion intake preserves native custody, path safety and actual Git composition [V4,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { normalizeItemPatch } from '../../../../../packages/items/index.js';
import { composeItemPatches } from '../../../../../packages/items/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const PLAIN = '--- a/web/value.txt\n+++ b/web/value.txt\n@@ -1 +1 @@\n-before\n+after\n';
const CANONICAL = 'diff --git a/web/value.txt b/web/value.txt\n' + PLAIN;

/** Capture a real successful CLI command rather than substituting a patch writer. */
async function run(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** A real submitted fixture with an existing regular file owned by its native web author. */
async function fixture(t) {
  const box = helpers.project('true');
  const item = (await run(box, box.repo, 'add', 'web', 'Plain companion', '--specs', 'G1')).item.item_id;
  const author = (await run(box, box.web, 'whoami')).id;
  await run(box, box.web, 'claim', String(item));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/value.txt'), 'before\n');
  box.git(box.web, 'add', 'web/value.txt');
  box.git(box.web, 'commit', '-m', 'test(web): seed a plain companion target [G1]');
  const source = box.git(box.web, 'rev-parse', 'HEAD').trim();
  // @pullboard-board-file journey: real CLI attachments and composition share this durable fixture board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  submitFixture(board, item, { agentId: author, commit: source, tree: box.git(box.web, 'rev-parse', `${source}^{tree}`).trim() });
  return { ...box, item, author, source, board };
}

test('plain diffs attach with canonical bytes and compose identically to Git headers [V4,H16]', async t => {
  const box = await fixture(t), file = join(box.dir, 'plain.patch');
  writeFileSync(file, PLAIN);
  const attached = await run(box, box.repo, 'patch', 'attach', String(box.item), file, '--key', 'plain', '--author', box.author, '--source', box.source);
  assert.equal(attached.changed, true);
  const [record] = store.itemPatches(box.board, box.item);
  assert.equal(record.patch, CANONICAL);
  assert.equal(record.digest, createHash('sha256').update(CANONICAL).digest('hex'));
  assert.equal(record.author.agentId, box.author);
  assert.equal(record.commit, box.source);
  const before = box.git(box.web, 'status', '--porcelain=v1');
  const actual = composeItemPatches(box.repo, { item_commit: box.source }, [record]);
  const canonical = composeItemPatches(box.repo, { item_commit: box.source }, [{ ...record, patch: CANONICAL }]);
  assert.deepEqual(actual, canonical);
  assert.equal(box.git(box.repo, 'show', `${actual.commit}:web/value.txt`).trim(), 'after');
  assert.equal(box.git(box.web, 'status', '--porcelain=v1'), before, 'composition does not mutate the builder checkout');
  writeFileSync(file, CANONICAL);
  const retry = await run(box, box.repo, 'patch', 'attach', String(box.item), file, '--key', 'plain', '--author', box.author, '--source', box.source);
  assert.equal(retry.changed, false, 'canonical retry binds the same immutable key and bytes');
  assert.equal(store.itemPatches(box.board, box.item).length, 1);
});

test('plain mismatched paths refuse without attaching or changing the native source [V4,H16]', async t => {
  const box = await fixture(t), file = join(box.dir, 'mismatch.patch');
  writeFileSync(file, PLAIN.replace('+++ b/web/value.txt', '+++ b/web/other.txt'));
  const result = await box.runLocal(box.repo, 'patch', 'attach', String(box.item), file, '--key', 'mismatch', '--author', box.author, '--source', box.source, '--json');
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).error.code, 'ITEM_PATCH_FORMAT');
  assert.deepEqual(store.itemPatches(box.board, box.item), []);
  assert.equal(store.getItem(box.board, box.item).item_commit, box.source);
});

test('plain normalization preserves header-like hunk content and multiple files [V4,H16]', () => {
  const body = '--- a/web/first.txt\n+++ b/web/first.txt\n@@ -1 +1 @@\n--- a/not-a-header\n+++ b/not-a-header\n';
  const second = '--- a/web/second.txt\n+++ b/web/second.txt\n@@ -1 +1 @@\n-old\n+new\n';
  assert.equal(normalizeItemPatch(body + second), 'diff --git a/web/first.txt b/web/first.txt\n' + body + 'diff --git a/web/second.txt b/web/second.txt\n' + second);
  const noNewline = PLAIN.replace('-before\n+after\n', '-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n');
  assert.equal(normalizeItemPatch(noNewline), 'diff --git a/web/value.txt b/web/value.txt\n' + noNewline);
});

test('plain unsafe, rename, binary and incomplete forms refuse before native storage [V4,H16]', () => {
  for (const patch of [
    PLAIN.replaceAll('web/value.txt', '../escape'), PLAIN.replaceAll('web/value.txt', '.git/config'),
    PLAIN.replaceAll('web/value.txt', '/absolute'), PLAIN.replaceAll('web/value.txt', 'web/space name'),
    PLAIN.replace('@@ -1 +1 @@', 'rename from web/value.txt\nrename to web/other.txt'),
    PLAIN.replace('@@ -1 +1 @@\n-before\n+after', 'GIT binary patch\nliteral 1\nencoded'),
    PLAIN.replace('+after\n', ''), PLAIN.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@'), PLAIN + '\0',
  ]) assert.throws(() => normalizeItemPatch(patch), { code: 'ITEM_PATCH_FORMAT' });
});

test('normalization preserves existing Git-format bytes including native binary custody [V4,H16]', () => {
  const binary = 'diff --git a/web/asset.bin b/web/asset.bin\nindex 1234567..7654321 100644\nGIT binary patch\nliteral 1\nIc${Nk000310RR91\n';
  assert.equal(normalizeItemPatch(CANONICAL), CANONICAL);
  assert.equal(normalizeItemPatch(binary), binary, 'existing Git/native binary records are not reinterpreted by plain intake');
});
