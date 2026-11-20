/** A withdrawn dependency never holds an accepted item back from landing; an open one still does [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { openCellBoard as openBoard } from '../../board/tests/fixtures/cell-board.js';
import { candidates } from '../index.js';

/** A real scratch repo with one commit, and a real in-memory board. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-withdrawn-dep-'));
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

/** Run selection with one verified item that waits after item 1, whose status is given. */
function select(t, dependencyStatus) {
  const { root, board, base } = scratch(t);
  const listed = [
    { item_id: 1, item_status: dependencyStatus, item_merged_commit: null, item_commit: base },
    { item_id: 2, item_status: 'verified', item_merged_commit: null, item_commit: base, item_after: '1',
      item_hold_at: null },
  ];
  return candidates(board, root, base, 8, { listItems: () => listed });
}

test('landing.dependency.an-accepted-item-whose-dependency-is: clause 1: an accepted item whose dependency is withdrawn is selected; an open dependency still blocks WAITS_ON_ITEM [C7]', t => {
  const withdrawn = select(t, 'withdrawn');
  assert.ok(!withdrawn.blocked.some(entry => entry.code === 'WAITS_ON_ITEM'), JSON.stringify(withdrawn.blocked));
  assert.deepEqual(withdrawn.ready.map(item => item.item_id), [2]);
  for (const status of ['open', 'claimed', 'submitted', 'verified']) {
    const waiting = select(t, status);
    assert.ok(!waiting.ready.some(item => item.item_id === 2), `${status} dependency keeps item 2 out of the batch`);
    assert.deepEqual(waiting.blocked.filter(entry => entry.id === 2).map(entry => [entry.code, entry.items]), [['WAITS_ON_ITEM', [1]]], status);
  }
});
