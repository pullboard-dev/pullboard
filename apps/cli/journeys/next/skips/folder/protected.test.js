/** next passes over an item whose branch sits in a locked folder and claims the next item; the folder stays (#3968) [B3,C7]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Item A, whose branch a locked folder keeps as evidence, and item B after it; one fresh web seat. */
function protectedBoard() {
  const box = e2e.project();
  const a = String(fileFixtureItem(box, box.repo, { lane: 'web', title: 'Kept in a locked folder', check: 'true', args: ['--specs', 'G1'] }).item_id);
  const b = String(fileFixtureItem(box, box.repo, { lane: 'web', title: 'Next free item', check: 'true', args: ['--specs', 'G1'] }).item_id);
  const folder = join(box.dir, `evidence-item-${a}`);
  box.git(box.repo, 'worktree', 'add', '-q', folder, '-b', `web/item-${a}`);
  box.git(box.repo, 'worktree', 'lock', '--reason', `Preserve item ${a} candidate`, folder);
  const root = join(box.dir, 'web-b');
  box.git(box.repo, 'worktree', 'add', '-q', root, '-b', 'web/web-b');
  const joined = joinFixtureSeat(box, root, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { box, a, b, folder, root };
}

test('clause 2: next names ITEM_FOLDER_PROTECTED for the locked item, claims the next one and leaves the folder locked [B3,C7]', () => {
  const { box, a, b, folder, root } = protectedBoard();
  const next = box.run(root, 'next');
  const all = `${next.out}\n${next.err}`;
  assert.equal(next.code, 0, all);
  assert.match(next.out, new RegExp(`skipped #${a}: \\[ITEM_FOLDER_PROTECTED\\] item branch web/item-${a} remains in protected folder`, 'u'), all);
  assert.match(next.out, new RegExp(`claimed #${b}:`, 'u'), all);
  assert.match(box.run(box.repo, 'show', a).out, new RegExp(`^#${a}\\s+open\\b`, 'mu'), 'A stays open');
  assert.ok(existsSync(join(folder, '.git')), 'the folder stays');
  assert.match(box.git(box.repo, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${folder.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n[^]*?locked Preserve item ${a} candidate`, 'u'), 'the folder stays locked');
});

test('pullboard claim of the locked item refuses ITEM_FOLDER_PROTECTED before the move, so A is never claimed (#5766) [B3,C7]', () => {
  const { box, a, folder, root } = protectedBoard();
  const claimed = box.run(root, 'claim', a);
  const all = `${claimed.out}\n${claimed.err}`;
  assert.notEqual(claimed.code, 0, all);
  assert.match(all, /ITEM_FOLDER_PROTECTED/u);
  assert.match(box.run(box.repo, 'show', a).out, new RegExp(`^#${a}\\s+open\\b`, 'mu'), 'A stays open');
  assert.ok(existsSync(join(folder, '.git')), 'the folder stays');
});
