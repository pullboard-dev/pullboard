/** Releasing an item with unmerged commits never removes its item folder [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('clause 1: releasing an item with an unmerged commit and running next leaves its folder in place [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'unlanded folder fixture', '--criterion', 'The work survives release', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = await box.inProcess(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  const path = JSON.parse(claimed.out).itemFolder;
  assert.equal(helpers.commitFile(box, path, 'web/unlanded.txt', 'unlanded\n', `feat(web): unlanded work [G1]`).status, 0);
  const released = await box.inProcess(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'keep unlanded work', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);
  assert.equal(existsSync(path), true, 'release keeps a clean folder whose branch has an unmerged commit');
  await box.inProcess(box.web, 'next', '--verify', '--no-next');
  assert.equal(existsSync(path), true, 'next keeps it too');
  assert.equal(box.git(path, 'branch', '--show-current'), `web/item-${id}`);
});
