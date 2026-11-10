/** A claim brings the item folder to main's tip and keeps every commit the item branch already had [C7,#3797]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('clause 1: after a claim, the item folder branch contains main\'s tip and keeps the item\'s own commits [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'claim starts at main tip fixture', '--criterion', 'The folder starts at main', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  assert.ok(path && existsSync(path), 'claim prints a real folder');

  // The item makes its own commit, then main moves on.
  const own = box.git(path, 'commit-tree', box.git(path, 'write-tree'), '-p', 'HEAD', '-m', 'feat(web): the item\'s own commit [G1]');
  box.git(path, 'update-ref', 'HEAD', own);
  writeFileSync(join(box.repo, 'main-moved.txt'), 'main advanced after the item commit\n');
  box.git(box.repo, 'add', 'main-moved.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main after the item commit');
  const main = box.git(box.repo, 'rev-parse', 'main');

  const renewed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(renewed.code, 0, renewed.err || renewed.out);
  assert.doesNotThrow(() => box.git(path, 'merge-base', '--is-ancestor', main, 'HEAD'), 'main\'s tip is in the folder branch');
  assert.doesNotThrow(() => box.git(path, 'merge-base', '--is-ancestor', own, 'HEAD'), 'the item\'s own commit is kept');
  assert.equal(box.git(path, 'status', '--porcelain'), '', 'the advanced folder is clean');
});
