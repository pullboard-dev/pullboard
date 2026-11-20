/** @pullboard-test-input source-cell apps/cli */
/** An item folder whose seat no longer holds the item names the seat folder to run next, status and shout from [C7,#11780]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeItemMarker } from '../../../../../packages/items/index.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** A project whose seat web-1 has an item folder beside it that the seat does not hold. */
function projectWithLeftFolder(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const folder = `${box.web}-item-7`;
  runFixtureGit(['worktree', 'add', '-q', folder, '-b', 'web/item-7'], { cwd: box.repo });
  writeItemMarker(folder, 'web-1', 7);
  return { box, folder };
}

test('cli.io-read-seat-folder.names-seat: clause 1: identifyCaller in a folder whose marker names a joined seat that no longer holds the item refuses NOT_JOINED naming the seat folder and the item number [C7,#11780]', async t => {
  const { box, folder } = projectWithLeftFolder(t);
  const out = await box.runLocal(folder, 'status');
  assert.notEqual(out.code, 0);
  assert.match(out.err, /NOT_JOINED/u);
  assert.ok(out.err.includes(`cd ${box.web}`), out.err);
  assert.match(out.err, /item #7/u);
});

test('cli.io-read-seat-folder.plain-folder-unchanged: clause 2: a worktree with no marker keeps today\'s NOT_JOINED text, and an item folder whose seat still holds the claim still resolves the seat [C7,#11780]', async t => {
  const { box } = projectWithLeftFolder(t);
  const plain = `${box.dir}/plain-worktree`;
  runFixtureGit(['worktree', 'add', '-q', plain, '-b', 'web/plain'], { cwd: box.repo });
  const refused = await box.runLocal(plain, 'status');
  assert.match(refused.err, /NOT_JOINED/u);
  assert.match(refused.err, /pullboard join <lane>/u);
  assert.ok(!refused.err.includes(box.web), refused.err);
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Held item', args: ['--specs', 'G1'], run: box.runLocal });
  const claimed = await box.runLocal(box.web, 'claim', String(item.item_id));
  assert.equal(claimed.code, 0, claimed.err);
  const held = await box.runLocal(`${box.web}-item-${item.item_id}`, 'status');
  assert.equal(held.code, 0, held.err);
});

test('cli.io-read-seat-folder.real-status: clause 3: the real status command in such a folder reads the seat path in its refusal [C7,#11780]', async t => {
  const { box, folder } = projectWithLeftFolder(t);
  const out = await box.runLocal(folder, 'status');
  assert.ok(out.err.includes(box.web), out.err);
});
