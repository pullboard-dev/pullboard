/** The landing step prunes a landed batch's gone seats and keeps live seats and unsaved work [R3,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  acceptedFolders,
  landOnce,
  worktrees,
} from '../../../tests/fixtures/land/prune.js';

const e2e = createE2eHelpers();
after(() => e2e.cleanup());
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a real landing keeps the item folders of a seat that is still live and says why [R3,C7]', () => {
  const box = landProject({ withWorktree: false });
  const { clean, folder } = acceptedFolders(box, { itemWorktree, submitItem, acceptItem });
  const result = landOnce(box);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.ok(result.lines.some(line => line.startsWith('landed ')), result.lines.join('\n'));
  assert.ok(worktrees(box).includes(folder(clean)) && existsSync(folder(clean)), 'a live seat keeps its landed folder');
  assert.ok(result.lines.some(line => line.includes('kept') && line.includes(folder(clean)) && line.includes('seat is live')), result.lines.join('\n'));
});
