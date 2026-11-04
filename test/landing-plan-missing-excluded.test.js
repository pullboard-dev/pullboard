/** Landing leaves one item without its own test plan out of the batch, and the rest still land [C7,#2897]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { candidates } from '../packages/landing/src/shell/landing-step-selection.js';
import { itemLandingPlanMissing } from '../packages/landing/src/shell/landing-step-gate.js';

/** A real repository whose one commit is both trunk and each item's checked head, so freshness holds. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-plan-missing-'));
  const board = openBoard(':memory:', { now: () => new Date('2026-11-04T07:00:00.000Z') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'file.js'), 'export const value = 1;\n');
  git('add', '-A');
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base'], { cwd: root });
  return { root, board, head: git('rev-parse', 'HEAD') };
}

/** A verified, unlanded item at the given commit. */
const verified = (id, commit) => ({ item_id: id, item_status: 'verified', item_merged_commit: null, item_commit: commit, item_hold_at: null, item_after: null });

test('an item without a test plan leaves the batch and the other item stays ready [C7,#2897]', t => {
  const { root, board, head } = repo(t);
  const listed = [verified(7, head), verified(8, head)];
  const selected = candidates(board, root, head, 8, { listItems: () => listed, planMissing: item => item.item_id === 8 });
  assert.deepEqual(selected.ready.map(item => item.item_id), [7]);
  assert.deepEqual(selected.blocked.map(entry => [entry.id, entry.code]), [[8, 'LAND_PLAN_MISSING']]);
  assert.match(selected.blocked[0].message, /set its check or resubmit it/u);
});

test('without the plan check every fresh item is ready, as before [C7,#2897]', t => {
  const { root, board, head } = repo(t);
  const selected = candidates(board, root, head, 8, { listItems: () => [verified(7, head), verified(8, head)] });
  assert.deepEqual(selected.ready.map(item => item.item_id), [7, 8]);
});

test('an item with no green submit proof has no landing plan [C7,#2897]', t => {
  const { root, board, head } = repo(t);
  assert.equal(itemLandingPlanMissing(root, board, verified(9, head), 'node bin/run-tests.js'), true);
});
