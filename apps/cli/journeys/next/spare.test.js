/** A claiming next moves the seat's prepared spare checkout into place instead of writing every file, and prepares the next spare [C7,#5776]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { SPARE_FROM_FILES } from '../../src/io/item/folder/spare.js';
import { spareFolderPath } from '../../src/io/item/folder/spare.js';

/** Just enough tracked files for the repository to keep a spare. */
const files = Object.fromEntries(Array.from({ length: SPARE_FROM_FILES }, (_, n) => [`web/many/file-${n}.js`, `export const n = ${n};\n`]));

/** Wait until the background spare is registered and unlocked, so the next claim can take it and cleanup finds no Git still writing. */
async function spareReady(box) {
  const spare = spareFolderPath(box.seats.actor.path);
  const row = () => box.git(box.root, 'worktree', 'list', '--porcelain').split('\n\n').find(text => text.split('\n')[0] === `worktree ${spare}`);
  await waitForCondition(() => Boolean(row()) && !/^locked/mu.test(row()) && existsSync(spare), `spare ${spare} prepared`, { state: row });
  return spare;
}

test('clause 1: the second claiming next moves the prepared spare into the item folder and prepares a new spare [C7]', async t => {
  const box = await fixture(t, { files });
  for (let n = 1; n <= 2; n++) box.add(`Spare item ${n}`, { brief: `Files: web/spare-${n}.js\nTest: the folder opens from the spare.` });
  const first = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(first.code, 0, first.out + first.err);
  const firstId = first.document.item.item_id;
  const spare = await spareReady(box);
  store.release(box.board, firstId, box.seats.actor.id, 'Measured next hands the item back', 'OTHER');
  box.git(box.root, 'worktree', 'remove', `${box.seats.actor.path}-item-${firstId}`);
  const started = performance.now();
  const second = await cli(box, box.seats.actor.path, ['next']);
  const ms = performance.now() - started;
  assert.equal(second.code, 0, second.out + second.err);
  const id = second.document.item.item_id;
  const folder = `${box.seats.actor.path}-item-${id}`;
  t.diagnostic(`next from the spare took ${Math.round(ms)} ms`);
  // A moved worktree keeps its administrative directory, so the item folder's Git dir names the spare it was.
  assert.equal(basename(box.git(folder, 'rev-parse', '--git-dir').trim()), basename(spare));
  assert.equal(box.git(folder, 'symbolic-ref', '--short', 'HEAD').trim(), `web/item-${id}`);
  assert.equal(box.git(folder, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.equal(box.git(folder, 'ls-files', 'web/many').trim().split('\n').length, SPARE_FROM_FILES);
  assert.equal(await spareReady(box), spare, 'the claim did not prepare a new spare');
});

test('clause 1: a small repository keeps no spare beside the seat [C7]', async t => {
  const box = await fixture(t);
  box.add('Small item', { brief: 'Files: web/small.js\nTest: a small repository adds its folder directly.' });
  const result = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(existsSync(spareFolderPath(box.seats.actor.path)), false);
});
