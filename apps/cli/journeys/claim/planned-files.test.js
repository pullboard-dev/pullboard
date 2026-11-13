/** A brief path missing from main and owned by no lane is a planned file of the item's lane [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { coordinatorPaths } from '../../src/io/commands/add.js';
import { onTrunk } from '../../src/io/item/bar.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const config = { lanes: { web: { owns: ['web/'] } } };

/** A fixture project whose main holds web/page.html and src/board.js, so the claim's own trunk reader sees them. */
function repoOnMain(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'));
  mkdirSync(join(box.repo, 'src'));
  writeFileSync(join(box.repo, 'web/page.html'), 'page\n');
  writeFileSync(join(box.repo, 'src/board.js'), 'board\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'base files');
  return box.repo;
}

test('a brief file missing on main and owned by no lane is no coordinator path, so the claim succeeds [C7]', t => {
  const root = repoOnMain(t);
  const item = { lane: 'web', brief: 'Files:\n- web/page.html\n- test/new-thing.test.js\n' };
  assert.deepEqual(coordinatorPaths(config, item), ['test/new-thing.test.js'], 'without the trunk reader it is still unowned');
  assert.deepEqual(coordinatorPaths(config, item, { present: onTrunk(root) }), []);
});

test('a brief path that exists on main outside the item lane still refuses CROSS_OWNERSHIP [C7]', t => {
  const root = repoOnMain(t);
  const item = { lane: 'web', brief: 'Files:\n- web/page.html\n- src/board.js\n- test/new-thing.test.js\n' };
  assert.deepEqual(coordinatorPaths(config, item, { present: onTrunk(root) }), ['src/board.js']);
});
