/** A claim whose item branch sits in a folder with no registered holder reports one line, never a stack trace [C7]. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';
import { fileFixtureItem, joinFixtureSeat } from './testkit-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * Seat web-1 claims an item, releases it, and its item folder moves to a path no seat owns;
 * a second web seat then claims the same item. Returns the box and the second claim's result.
 */
function claimWithStrayFolder() {
  const box = e2e.project();
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Stray folder', check: 'true', args: ['--specs', 'G1'] });
  const id = String(item.item_id);
  const first = box.run(box.web, 'claim', id);
  assert.equal(first.code, 0, first.err);
  const folder = /item folder: (.+)/u.exec(first.out)?.[1];
  assert.ok(folder, first.out);
  const released = box.run(box.web, 'release', id, '--reason', 'BLOCKED', '--note', 'fixture');
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  const stray = join(box.dir, `nobody-item-${id}`);
  // The release may already have removed the folder: check the item branch out at the stray path either way.
  if (existsSync(folder)) {
    try { box.git(box.repo, 'worktree', 'unlock', folder); } catch { /* not locked */ }
    box.git(box.repo, 'worktree', 'move', folder, stray);
  } else {
    box.git(box.repo, 'worktree', 'add', '-q', stray, `web/item-${id}`);
  }
  const web2 = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', web2, '-b', 'web/two');
  const joined = joinFixtureSeat(box, web2, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  return { stray, claim: box.run(web2, 'claim', id) };
}

test('clause 1: claim names the unregistered prior folder as ITEM_FOLDER_UNREGISTERED with a next step, no stack trace [C7]', () => {
  const { stray, claim } = claimWithStrayFolder();
  const all = `${claim.out}\n${claim.err}`;
  assert.doesNotMatch(all, /\n\s+at /u, 'no Node stack trace');
  assert.match(all, /ITEM_FOLDER_UNREGISTERED/u);
  assert.ok(all.includes(stray), 'the message names the folder');
  assert.match(all, /coordinator archives or removes the folder, or the seat continues in its own folder/u);
});

test('clause 2: claim still completes and reports the retained folder in one line [C7]', () => {
  const { stray, claim } = claimWithStrayFolder();
  assert.equal(claim.code, 0, `${claim.out}\n${claim.err}`);
  assert.match(claim.out, /claimed #\d+ until /u, 'the normal claim lines print');
  assert.equal(claim.out.split('\n').filter(line => line.includes(stray)).length, 1, 'the retained folder is one line');
});
