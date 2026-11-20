/** add and edit refuse a bar whose missing file an unmerged item branch adds, behind items.barRulesAtAdd [C7,#11741]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireAfterNeeded } from '../../../../src/io/item/bar.js';
import { after } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Commit `file` on main, or on a new branch `<lane>/item-<id>` cut from main when one is given, and return to main. */
function put(box, file, branch) {
  if (branch) box.git(box.repo, 'checkout', '-q', '-b', branch, 'main');
  mkdirSync(dirname(join(box.repo, file)), { recursive: true });
  writeFileSync(join(box.repo, file), '// fixture\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: fixture');
  if (branch) box.git(box.repo, 'checkout', '-q', 'main');
}

/** A fixture repo whose main holds one source file, with item 7 and item 9 branches each adding one more file, as a context the bar check reads. */
function repo() {
  const box = helpers.project('true', helpers.sandbox());
  put(box, 'packages/demo/src/io/thing.js');
  put(box, 'packages/demo/src/io/fresh.js', 'core/item-7');
  put(box, 'packages/demo/src/io/other.js', 'core/item-9');
  return { info: { root: box.repo } };
}

const row = (id, status, extra = {}) => ({ item_id: id, item_lane: 'core', item_status: status, ...extra });
const bar = { criterion: '1. packages/demo/src/io/fresh.js and packages/demo/src/io/other.js are used by packages/demo/src/io/thing.js [test]' };

test('cli.io-item-bar-after.names-the-item-a-missing-file-waits-on: clause 1: with items.barRulesAtAdd on, a bar naming a path missing from main that an unmerged open or verified item branch adds is refused AFTER_NEEDED unless --after names it [C7,#11741]', () => {
  const ctx = repo();
  const items = () => [row(7, 'open'), row(9, 'verified')];
  assert.throws(() => requireAfterNeeded(ctx, bar, { on: true, after: [], items }), error => error.code === 'AFTER_NEEDED');
  assert.throws(() => requireAfterNeeded(ctx, bar, { on: true, after: ['7'], items }), error => error.code === 'AFTER_NEEDED' && !/#7\b/u.test(error.message), 'an item --after already names is not named again');
  requireAfterNeeded(ctx, bar, { on: true, after: [7, 9], items });
});

test('cli.io-item-bar-after.refusal-names-each-item-and-the-rerun: clause 2: the AFTER_NEEDED refusal names each such item id with its file and the next step rerun with --after <id> [C7,#11741]', () => {
  const ctx = repo();
  assert.throws(() => requireAfterNeeded(ctx, bar, { on: true, items: () => [row(7, 'open'), row(9, 'submitted')] }), error => {
    assert.equal(error.code, 'AFTER_NEEDED');
    assert.match(error.message, /packages\/demo\/src\/io\/fresh\.js \(added by the unmerged branch of #7\)/u);
    assert.match(error.message, /packages\/demo\/src\/io\/other\.js \(added by the unmerged branch of #9\)/u);
    assert.match(error.next, /rerun with --after 7,9/u);
    return true;
  });
  assert.throws(() => requireAfterNeeded(ctx, { criterion: '1. packages/demo/src/io/fresh.js is used [test]' }, { on: true, items: () => [row(7, 'open'), row(9, 'open')] }),
    error => error.next === 'rerun with --after 7');
});

test('cli.io-item-bar-after.accepts-the-bar-with-the-setting-off: clause 3: with the setting off (the default), or a missing path no unmerged item branch adds, add and edit accept the bar as today [C7,#11741]', () => {
  const ctx = repo();
  const items = () => [row(7, 'open'), row(9, 'verified')];
  requireAfterNeeded(ctx, bar, { on: false, items });
  const absent = { criterion: '1. packages/demo/src/io/nowhere.js is used by packages/demo/src/io/thing.js [test]' };
  requireAfterNeeded(ctx, absent, { on: true, items });
  requireAfterNeeded(ctx, { criterion: '1. packages/demo/src/io/thing.js is changed [test]' }, { on: true, items });
  requireAfterNeeded(ctx, bar, { on: true, items: () => [row(7, 'claimed'), row(9, 'verified', { item_merged_commit: 'abc' }), row(8, 'open')] });
});
