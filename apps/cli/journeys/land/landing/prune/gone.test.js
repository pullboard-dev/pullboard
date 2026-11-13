/** The landing step prunes the landed folder of a gone seat and keeps the folder holding unsaved work [R3,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../../tests/fixtures/land/project.js';
import {
  acceptedFolders,
  landOnce,
  worktrees,
} from '../../../../tests/fixtures/land/prune.js';

const e2e = createE2eHelpers();
after(() => e2e.cleanup());
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a real landing prunes the landed folder of a gone seat and keeps the folder holding unsaved work [R3,C7]', () => {
  const box = landProject({ withWorktree: false });
  const { clean, dirty, folder } = acceptedFolders(box, { itemWorktree, submitItem, acceptItem });
  const result = landOnce(box, 3_600_000);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.ok(result.lines.some(line => line.startsWith('landed ')), result.lines.join('\n'));
  const after = worktrees(box);
  assert.ok(!after.includes(folder(clean)) && !existsSync(folder(clean)), `the landed clean folder is pruned: ${result.lines.join('\n')}`);
  assert.ok(after.includes(folder(dirty)) && existsSync(join(folder(dirty), 'unsaved.txt')), 'the folder with uncommitted work is kept');
  assert.ok(result.lines.some(line => line.includes('kept') && line.includes(folder(dirty)) && /dirty worktree/u.test(line)), result.lines.join('\n'));
  assert.ok(after.includes(clean.path) && after.includes(dirty.path), 'the seat checkouts stay registered');
  assert.ok(box.git(box.repo, 'branch', '--list', 'web/land-1').includes('web/land-1'), 'the seat branch is kept');
});
