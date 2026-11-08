/** Landing selection treats a withdrawn dependency as met and records that in the batch entry [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { openBoard } from '../../../apps/lib/index.js';
import { candidates } from '../src/shell/landing-step-selection.js';
import { landingEntry } from '../src/shell/landing-step-selection.js';

/** A real scratch repo with one commit, and a real in-memory board. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-step-selection-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const board = openBoard(':memory:', { now: () => new Date('2026-11-06T16:00:00.000Z') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { root, board, base: git('rev-parse', 'HEAD') };
}

test('clause 1: a verified item whose only unmerged dependency is withdrawn is selected and the batch entry records it [test] [C7]', t => {
  const { root, board, base } = scratch(t);
  const listed = [
    { item_id: 2658, item_status: 'withdrawn', item_merged_commit: null, item_commit: base },
    { item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_after: '2658', item_hold_at: null },
  ];
  const { ready, blocked } = candidates(board, root, base, 8, { listItems: () => listed });
  assert.deepEqual(blocked, []);
  assert.deepEqual(ready.map(item => item.item_id), [2822]);
  assert.deepEqual(landingEntry(ready[0]).withdrawnDependencies, [2658], 'the batch entry names the withdrawn dependency');
  assert.equal('withdrawnDependencies' in landingEntry({ item_id: 1, item_commit: 'a', item_landing_commit: 'a' }), false, 'an item with no withdrawn dependency records none');
});
