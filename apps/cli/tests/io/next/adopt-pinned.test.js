/** adoptPinnedHead merges the newest handoff pin of an item into a folder, and leaves the folder clean when it cannot [C7,#9688]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptPinnedHead } from '../../../src/io/resume/adopt.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';

const ITEM = 77;

/** A project with a worktree folder that committed a file under the given content and an empty target folder beside it. */
function pinned(t, { targetFile = null } = {}) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const source = join(box.dir, 'pinned-source'), target = join(box.dir, 'pinned-target');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'pin/source', source, 'main');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'pin/target', target, 'main');
  writeFileSync(join(source, 'pinned.txt'), 'pinned work\n');
  box.git(source, 'add', '-A');
  box.git(source, 'commit', '-q', '-m', 'feat(web): pinned work [G1]');
  const head = box.git(source, 'rev-parse', 'HEAD').trim();
  const pin = `refs/pullboard/handoffs/${ITEM}/${head.slice(0, 12)}`;
  box.git(box.repo, 'update-ref', pin, head);
  if (targetFile !== null) {
    writeFileSync(join(target, 'pinned.txt'), targetFile);
    box.git(target, 'add', '-A');
    box.git(target, 'commit', '-q', '-m', 'feat(web): another take [G1]');
  }
  return { box, target, head, pin };
}

test('cli.next.adopt-pinned.adoptpinnedhead-merges-the-newest-handoff-pin: clause 1: adoptPinnedHead merges the newest handoff pin into the folder and returns its pin and head [C7,#9688]', t => {
  const { box, target, head, pin } = pinned(t);
  assert.deepEqual(adoptPinnedHead(box.repo, target, ITEM), { pin, head });
  assert.ok(existsSync(join(target, 'pinned.txt')), 'the pinned file is in the folder');
  assert.equal(box.git(target, 'merge-base', '--is-ancestor', head, 'HEAD') ?? '', '', 'the pinned head is in the folder branch');
});

test('cli.next.adopt-pinned.adoptpinnedhead-returns-null-when-the-item: clause 1: adoptPinnedHead returns null when the item has no pin [C7,#9688]', t => {
  const { box, target } = pinned(t);
  assert.equal(adoptPinnedHead(box.repo, target, ITEM + 1), null);
  assert.equal(existsSync(join(target, 'pinned.txt')), false);
});

test('cli.next.adopt-pinned.adoptpinnedhead-returns-null-and-leaves-the: clause 1: adoptPinnedHead returns null and leaves the folder clean on a merge conflict [C7,#9688]', t => {
  const { box, target } = pinned(t, { targetFile: 'a different take\n' });
  assert.equal(adoptPinnedHead(box.repo, target, ITEM), null);
  assert.equal(box.git(target, 'status', '--porcelain').trim(), '', 'no conflict markers or merge state remain');
});
