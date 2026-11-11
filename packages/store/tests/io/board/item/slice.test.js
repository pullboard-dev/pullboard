/** Slice creation is holder-authorized and fenced by the parent's frozen bar [C7,B26,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { ITEM_SLICE_ENGINE } from '../../../../../state/light.js';
import { prepareEngineMove } from '../../../../../state/index.js';
import { applyRelayMove } from '../../../../../state/index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellClaim } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { FIXTURE_MODEL_EARLIER } from '../../../../../../apps/cli/tests/fixtures/testkit.js';

test('holder and coordinator create slices, others are refused, and old engines cannot replay them [C7,B26,H16]', t => {
  const project = cellProject(t);
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const holderSeat = cellSeat(board, { lane: 'web', path: web });
  const parent = cellItem(board, { lane: 'web', title: 'Parent', criterion: 'The whole feature works', check: 'true', route: 'strong' }).item_id;
  cellClaim(board, parent, holderSeat, { root: web, itemFolder: true });
  /** Create one slice under the parent the way `pullboard slice` does: bound to the parent's current frozen bar. */
  const slice = (agentId, request) => store.createItemSlice(board, { agentId, parentId: parent,
    parentDigest: store.getItem(board, parent).item_frozen_digest, ...request });
  const made = store.getItem(board, slice(holderSeat.id, { title: 'View part', lane: 'web', files: ['web/view.js'], check: 'true' }).item);
  assert.equal(made.item_parent_id, parent);
  assert.equal(made.item_criterion, 'The whole feature works');
  assert.equal(JSON.parse(made.item_frozen).criterion, 'The whole feature works');
  assert.equal(JSON.parse(made.item_frozen).check, 'true');
  assert.ok(made.item_frozen_digest, 'the child bar is frozen before it is offered');
  const coordinator = store.getItem(board, slice('coordinator', { title: 'API part', lane: 'api', files: ['api/view.js'], check: 'true' }).item);
  assert.equal(coordinator.item_parent_id, parent);
  assert.equal(coordinator.item_lane, 'api');
  const peer = cellSeat(board, { lane: 'web', path: join(project.dir, 'other-slice-seat'), model: FIXTURE_MODEL_EARLIER });
  assert.throws(() => slice(peer.id, { title: 'Unauthorized', lane: 'web', files: ['web/no.js'] }), /SLICE_OWNER/u);
  cellClaim(board, made.item_id, peer, { root: project.repo, itemFolder: true });
  const claimed = store.getItem(board, made.item_id);
  assert.equal(claimed.item_frozen_digest, made.item_frozen_digest, 'claim preserves the inherited frozen bar');
  const holder = holderSeat.id;
  const saved = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item-slice:${made.item_id}`).meta_value);
  assert.equal(saved.frozenBar, store.getItem(board, parent).item_frozen, 'the whole frozen bar is retained');
  const before = store.listItems(board, { all: true }).length;
  const request = { agentId: holder, parentId: parent, parentDigest: store.getItem(board, parent).item_frozen_digest,
    title: 'Replay control', files: ['web/replay.js'], lane: 'web', check: 'true' };
  const move = prepareEngineMove(board, 'createItemSlice', [request], { id: 'slice-old-engine', actor: holder });
  const transport = { sequence: 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: holder, userId: 'fixture-person' } };
  assert.throws(() => applyRelayMove(board, { ...move, engine: ITEM_SLICE_ENGINE - 1 }, transport), /RELAY_MOVE/u);
  assert.equal(store.listItems(board, { all: true }).length, before);
  const replayed = applyRelayMove(board, move, transport);
  assert.equal(store.getItem(board, replayed.result.item).item_criterion, 'The whole feature works');
  assert.equal(store.listItems(board, { all: true }).length, before + 1);
  assert.throws(() => store.createItemSlice(board, { ...request, parentDigest: 'stale' }), /SLICE_BAR_MOVED/u);
});
