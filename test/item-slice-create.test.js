/** Slice creation is holder-authorized and fenced by the parent's frozen bar [C7,B26,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { ITEM_SLICE_ENGINE } from '../src/item-slice-engine.js';
import { prepareEngineMove, applyRelayMove } from '../packages/state/index.js';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
function json(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

test('holder and coordinator create slices, others are refused, and old engines cannot replay them [C7,B26,H16]', () => {
  const box = helpers.project('true');
  const parent = json(box, box.repo, 'add', 'web', 'Parent', '--criterion', 'The whole feature works', '--check', 'true').item.item_id;
  json(box, box.web, 'claim', String(parent));
  const made = json(box, box.web, 'slice', String(parent), 'View part', '--files', 'web/view.js', '--check', 'true').item;
  assert.equal(made.item_parent_id, parent);
  assert.equal(made.item_criterion, 'The whole feature works');
  const coordinator = json(box, box.repo, 'slice', String(parent), 'API part', '--lane', 'api', '--files', 'api/view.js', '--check', 'true').item;
  assert.equal(coordinator.item_parent_id, parent);
  assert.equal(coordinator.item_lane, 'api');
  const peer = join(box.dir, 'other-slice-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', peer, 'HEAD');
  json(box, peer, 'join', 'web', '--model', 'slice-peer');
  const refused = box.run(peer, 'slice', String(parent), 'Unauthorized', '--files', 'web/no.js');
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /SLICE_OWNER/u);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const holder = store.agentAt(board, box.web).agent_id;
    const before = store.listItems(board, { all: true }).length;
    const request = { agentId: holder, parentId: parent, parentDigest: store.getItem(board, parent).item_frozen_digest,
      title: 'Replay control', files: ['web/replay.js'], lane: 'web', check: 'true' };
    const move = prepareEngineMove(board, 'createItemSlice', [request], { id: 'slice-old-engine', actor: holder });
    const transport = { sequence: 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: holder, userId: 'fixture-person' } };
    assert.throws(() => applyRelayMove(board, { ...move, engine: ITEM_SLICE_ENGINE - 1 }, transport), /RELAY_MOVE/u);
    assert.equal(store.listItems(board, { all: true }).length, before);
    assert.throws(() => store.createItemSlice(board, { ...request, parentDigest: 'stale' }), /SLICE_BAR_MOVED/u);
  } finally { store.closeBoard(board); }
});
