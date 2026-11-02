/** Real claim and release lifecycle for isolated item worktrees [B5,C7]. */
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

test('[B5,C7] claim opens a folder; release removes a clean folder and the next claim reuses its branch', t => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const added = box.run(box.repo, 'add', 'web', 'item folder fixture', '--criterion', 'The item is isolated', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const first = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(first.code, 0, first.err || first.out);
  const path = JSON.parse(first.out).itemFolder;
  assert.ok(path && existsSync(path), 'claim prints a real folder');
  assert.equal(box.git(path, 'branch', '--show-current'), `web/item-${id}`);
  assert.equal(box.git(path, 'rev-parse', 'HEAD'), box.git(box.repo, 'rev-parse', 'main'));
  const released = box.run(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'exercise reuse', '--no-next');
  assert.equal(released.code, 0, released.err || released.out);
  assert.equal(existsSync(path), false, 'release removes the clean item folder');
  assert.equal(box.git(box.repo, 'rev-parse', `refs/heads/web/item-${id}`), box.git(box.repo, 'rev-parse', 'main'), 'release retains the branch');
  const again = box.run(box.web, 'claim', String(id));
  assert.equal(again.code, 0, again.err || again.out);
  assert.ok(again.out.includes(`item folder: ${path}`), 'text output names the reused folder');
  writeFileSync(join(path, 'uncommitted.txt'), 'preserve me\n');
  const dirty = box.run(box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'retain dirty work', '--no-next');
  assert.equal(dirty.code, 0, dirty.err || dirty.out);
  assert.equal(existsSync(join(path, 'uncommitted.txt')), true, 'uncommitted work prevents cleanup');
  unlinkSync(join(path, 'uncommitted.txt'));
  box.run(box.web, 'next', '--verify', '--no-next');
  assert.equal(existsSync(path), false, 'next removes the released folder once its work is clean');
  assert.ok(box.git(box.repo, 'rev-parse', `refs/heads/web/item-${id}`), 'next retains the released branch');
});
