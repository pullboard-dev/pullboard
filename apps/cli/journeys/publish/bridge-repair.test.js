/** CI findings on a merged item create one linked repair and update the same PR [B2,R3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bridgeProject,
  gateHeads,
  bridgeProvider,
  landBridgeItems,
  landBridgeRepair,
  runBridgeCLI,
} from '../../tests/fixtures/bridge.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';

test('CI findings preserve the merged item and create one linked repair, then update the same PR [B2,R3]', async t => {
  const box = bridgeProject(t);
  const entries = landBridgeItems(box);
  const provider = await bridgeProvider(t, box);
  const first = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(first.code, 0, first.err);
  const pull = provider.pulls[0];
  const oldHead = pull.head.sha;
  provider.checks = [
    { id: 301, name: 'linux / behavior', head_sha: oldHead, status: 'completed', conclusion: 'failure',
      html_url: 'https://github.com/fixture/repository/actions/runs/301' },
    { id: 302, name: 'unattributed infrastructure', head_sha: oldHead, status: 'completed', conclusion: 'failure' },
    { id: 303, name: 'stale unrelated job', head_sha: '0'.repeat(40), status: 'completed', conclusion: 'failure' },
  ];
  provider.annotationsByRun[301] = [{ path: entries[0].file, annotation_level: 'failure' }];
  provider.annotationsByRun[302] = [];
  const observed = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(observed.code, 0, observed.err);
  const items = onBoard(box, board => store.listItems(board, { all: true }));
  const children = items.filter(item => item.item_parent_id === entries[0].id);
  assert.equal(children.length, 1);
  const repair = children[0];
  assert.equal(items.find(item => item.item_id === entries[0].id).item_status, 'verified');
  assert.equal(items.find(item => item.item_id === entries[0].id).item_merged_commit !== null, true);
  assert.equal(items.filter(item => item.item_parent_id === entries[1].id).length, 0);
  const facts = onBoard(box, board => store.itemThread(board, entries[0].id));
  assert.ok(facts.some(fact => fact.type === 'fact' && fact.text.includes('linux / behavior') && fact.text.includes('/runs/301')));
  assert.ok(JSON.parse(observed.out).unattributed.some(job => job.job === 'unattributed infrastructure'));
  assert.equal((await runBridgeCLI(box, 'publish', '--json')).code, 0);
  assert.equal(onBoard(box, board => store.listItems(board, { all: true })).filter(item => item.item_parent_id === entries[0].id).length, 1,
    'polling the same failing run creates no duplicate child');
  landBridgeRepair(box, repair.item_id, entries[0].file);
  provider.checks = [];
  const updated = await runBridgeCLI(box, 'publish', '--json');
  assert.equal(updated.code, 0, updated.err);
  assert.equal(provider.pulls.length, 1);
  assert.notEqual(pull.head.sha, oldHead, 'the actual newly proven repair head updates the original PR');
  assert.ok(pull.body.includes(`#${repair.item_id}`));
  assert.ok(gateHeads(box).includes(pull.head.sha));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published);
});
