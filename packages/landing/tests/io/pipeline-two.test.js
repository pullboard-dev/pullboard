/** Pipelined landing selection admits a second batch, caps at two, and stays single-flight by default [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../gate/tests/fixtures/child.js';
import { fixtureOpenBoard } from '../../../board/tests/fixtures/board.js';
import * as store from '../../../store/index.js';
import { candidates } from '../../src/io/step/selection.js';

/** A real scratch repo with one commit, and a real private board file. */
function scratch(t) {
  const fixture = privateFixtureFiles('pullboard-pipeline-two-'), root = fixture.root;
  const vcs = (...args) => runFixtureChild('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  vcs('init', '-q', '-b', 'main');
  fixture.write('a.txt', 'base\n');
  vcs('add', '-A');
  vcs('commit', '-q', '-m', 'base');
  const boards = privateFixtureFiles('pullboard-pipeline-two-board-');
  const board = fixtureOpenBoard({ boardFile: join(boards.root, 'board.sqlite') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); rmSync(boards.root, { recursive: true, force: true }); });
  return { root, board, base: vcs('rev-parse', 'HEAD') };
}

test('landing.selection.pipeline-on-starts-second-while-one-in-flight: clause 1: with landing.pipeline on, selection starts a second batch while one is in flight [test] [C7]', t => {
  const { root, board, base } = scratch(t);
  const listed = [{ item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_hold_at: null }];
  const selected = candidates(board, root, base, 8, { listItems: () => listed, pipeline: true, batches: [{ id: 'first', state: 'gating' }] });
  assert.deepEqual(selected.ready.map(item => item.item_id), [2822]);
  assert.deepEqual(selected.blocked, []);
});

test('landing.selection.pipeline-on-third-waits-at-two: clause 2: with landing.pipeline on, a third batch waits until one of two ends [test] [C7]', t => {
  const { root, board, base } = scratch(t);
  const listed = [{ item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_hold_at: null }];
  const selected = candidates(board, root, base, 8, { listItems: () => listed, pipeline: true,
    batches: [{ id: 'first', state: 'gating' }, { id: 'second', state: 'ready' }] });
  assert.deepEqual(selected.ready, []);
  assert.deepEqual(selected.blocked, [], 'the item waits rather than becoming blocked');
  const afterOneEnds = candidates(board, root, base, 8, { listItems: () => listed, pipeline: true,
    batches: [{ id: 'first', state: 'landed' }, { id: 'second', state: 'ready' }] });
  assert.deepEqual(afterOneEnds.ready.map(item => item.item_id), [2822]);
});

test('landing.selection.pipeline-off-keeps-single-flight: clause 3: with landing.pipeline off, selection waits for the in-flight batch and admits the next when idle [test] [C7]', t => {
  const { root, board, base } = scratch(t);
  const listed = [{ item_id: 2822, item_status: 'verified', item_merged_commit: null, item_commit: base, item_hold_at: null }];
  const waiting = candidates(board, root, base, 8, { listItems: () => listed, batches: [{ id: 'first', state: 'gating' }] });
  assert.deepEqual(waiting.ready, []);
  assert.deepEqual(waiting.blocked, []);
  const idle = candidates(board, root, base, 8, { listItems: () => listed, batches: [] });
  assert.deepEqual(idle.ready.map(item => item.item_id), [2822]);
});
