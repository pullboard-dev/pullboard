/** A claim switches the seat's own idle item folder to the new item instead of creating a worktree [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** File one item in the web lane and return its id. */
async function file(box, title) {
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', title, '--criterion', 'The item is isolated', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  return JSON.parse(added.out).item.item_id;
}

/** Claim an item through the real CLI and return its folder. */
async function claim(box, id) {
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  return JSON.parse(claimed.out).itemFolder;
}

/** The number of registered worktrees. */
function worktrees(box) { return box.git(box.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length; }

/** Leave an idle clean item folder for an unclaimed item beside the seat, as a finished item leaves one. */
function idleFolder(box, id) {
  const path = `${box.web}-item-${id}`;
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/item-${id}`, path, 'main');
  return path;
}

test('clause 1: [C7] a claim switches the seat idle clean item folder to the new item branch and creates a worktree only when none is idle', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const old = await file(box, 'old reuse'), fresh = await file(box, 'fresh reuse'), last = await file(box, 'last reuse');
  const idle = idleFolder(box, old);
  const before = worktrees(box);
  const reused = await claim(box, fresh);
  assert.equal(reused, `${box.web}-item-${fresh}`);
  assert.equal(box.git(reused, 'branch', '--show-current'), `web/item-${fresh}`, 'the folder is on the new item branch');
  assert.equal(worktrees(box), before, 'no new worktree was created');
  assert.equal(existsSync(idle), false, 'the idle folder moved to the new item path');
  const created = await claim(box, last);
  assert.equal(worktrees(box), before + 1, 'with no idle folder a claim creates a worktree');
  assert.equal(box.git(created, 'branch', '--show-current'), `web/item-${last}`);
});

test('clause 1: [C7] a dirty idle folder is never reused or deleted by a claim', async t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const old = await file(box, 'dirty old'), fresh = await file(box, 'dirty fresh');
  const idle = idleFolder(box, old);
  writeFileSync(join(idle, 'draft.txt'), 'keep me\n');
  const before = worktrees(box);
  const made = await claim(box, fresh);
  assert.notEqual(made, idle);
  assert.equal(worktrees(box), before + 1, 'a new worktree was created');
  assert.equal(existsSync(join(idle, 'draft.txt')), true, 'the dirty folder keeps its file');
  assert.equal(box.git(idle, 'branch', '--show-current'), `web/item-${old}`);
});
