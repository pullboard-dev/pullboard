/** @pullboard-test-input packages/landing/src/io/step/merge.js */
/** @pullboard-test-input packages/landing/src/io/land/squash.js */
/** The land step lands an item as one single-parent commit with landing.squash on, and as a --no-ff merge when off [C7,#9220]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../store/index.js';
import { loadConfig } from '../../../../config/index.js';
import { mergeGroup } from '../../../src/io/step/merge.js';

const git = (root, ...args) => runFixtureGit(args, { cwd: root }).trim();

/** Land one item through mergeGroup against a real repo, with landing.squash set as given; returns what main looks like afterwards. */
async function landOne(t, squash) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-merge-squash-');
  const board = openCellBoard(join(dir, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, squash ? { landing: { squash: true } } : {});
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const root = repo.root;
  const base = repo.commit;
  repo.put('web/page.txt', 'page\n');
  repo.commitAll();
  repo.put('web/more.txt', 'more\n');
  const tip = repo.commitAll();
  git(root, 'checkout', '-q', '--detach', base);
  repo.put('docs/trunk.txt', 'trunk\n');
  const trunk = repo.commitAll();
  const item = cellItem(board, { lane: 'web', title: 'Add the page', specIds: ['G1'] });
  const state = {
    board, config: loadConfig(root), say() {}, onWait() {}, checkLease: async () => {},
    landingPorts: { badgeCounts: () => ({}), writeBadges: () => [] },
    write: async (_name, [{ batch }]) => batch,
    batch: { id: 'b1', root, base: trunk, external: true, candidates: [{ id: item.item_id, commit: tip }], items: [], conflicts: [], resolutions: [] },
  };
  const result = await mergeGroup(state, [{ id: item.item_id, commit: tip }]);
  const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
  return { root, id: item.item_id, tip, trunk, result, parents, head: git(root, 'rev-parse', 'HEAD'), message: git(root, 'log', '-1', '--format=%B') };
}

test('clause 1: with landing.squash on, the land step merges an item as one single-parent commit with the landing message and an item ref [C7,#9220]', async t => {
  const landed = await landOne(t, true);
  assert.deepEqual(landed.parents, [landed.trunk], 'one parent: the trunk the batch was built on');
  assert.equal(landed.result.tip, landed.head);
  assert.match(landed.message, new RegExp(`Pullboard-Item: #${landed.id}\\b`, 'u'));
  assert.equal(git(landed.root, 'rev-parse', `refs/pullboard/items/${landed.id}`), landed.tip, 'the item ref keeps the branch tip reachable');
  assert.equal(landed.result.items[0].merge, landed.head, 'the board records the squash commit as the item landing');
  assert.ok(git(landed.root, 'ls-tree', '-r', '--name-only', 'HEAD').includes('web/more.txt'));
});

test('clause 2: with landing.squash off (the default), the land step merges with --no-ff as before [C7,#9220]', async t => {
  const landed = await landOne(t, false);
  assert.equal(landed.parents.length, 2, 'a merge commit with two parents');
  assert.equal(landed.parents[0], landed.trunk);
  assert.equal(landed.parents[1], landed.tip);
  assert.equal(runFixtureGit(['for-each-ref', `refs/pullboard/items/${landed.id}`], { cwd: landed.root }).trim(), '', 'no item ref is written');
});
