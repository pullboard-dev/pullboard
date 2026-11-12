/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js */
/** Destination imports obey the same creation grants as ordinary additions [E15,E21,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { appliedSequence } from '../../../../../state/index.js';
import { applyEngineMove } from '../../../../../state/index.js';
import { prepareEngineMove } from '../../../../../state/index.js';
import { exportBoard } from '../../../../index.js';
import { importBoard } from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';

test('a rehome destination import obeys lane and claimed item grants on independent replicas [E15,E21,H16]', t => {
  const sourceProject = cellProject(t);
  const destinationProject = cellProject(t);
  const source = cellBoard(t, sourceProject.boardFile);
  const destination = cellBoard(t, destinationProject.boardFile);
  const peer = cellBoard(t, ':memory:');
  const web = cellSeat(destination, { lane: 'web', path: destinationProject.repo }).id;
  const api = cellSeat(destination, { lane: 'api', path: join(destinationProject.dir, 'api-seat') }).id;
  /** Reserve a genuine destination id and retain the exact source move's immutable record. */
  const recordFor = title => {
    const id = cellItem(source, { lane: 'web', title,
      criterion: 'The original proof file exists.', check: 'test -f web/grant-proof' }).item_id;
    const moveId = `destination-grant-${id}`;
    const destinationItemId = store.reserveRehomeItemId(destination, store.boardId(source), moveId, { agentId: 'coordinator' });
    return store.rehomeItem(source, id, { agentId: 'coordinator', sourceMoveId: moveId,
      destinationBoardId: store.boardId(destination), destinationItemId });
  };
  const records = ['Allowed import', 'Wrong lane import', 'Claimed seat import'].map(recordFor);
  importBoard(peer, exportBoard(destination));
  /** Replay one authentic public operation against two separately opened SQLite boards. */
  const apply = (record, actor) => {
    const move = prepareEngineMove(destination, 'applyRehomeItem', [record, { destinationAgentId: actor }]);
    const receipt = { sequence: appliedSequence(destination) + 1, at: new Date().toISOString() };
    const outcomes = [destination, peer].map(board => applyEngineMove(board, move, receipt));
    assert.deepEqual(outcomes[0], outcomes[1], 'independent replicas agree on the permission result');
    return { move, receipt, outcome: outcomes[0] };
  };
  const allowed = apply(records[0], web);
  assert.equal(allowed.outcome.error, undefined, 'an unclaimed seat may create an item in its own lane');
  assert.equal(allowed.outcome.result, records[0].destinationItemId);
  const wrongLane = apply(records[1], api);
  assert.equal(wrongLane.outcome.error?.code, 'AGENT_GRANT_LANE');
  for (const board of [destination, peer]) {
    assert.equal(board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(records[1].destinationItemId), undefined,
      'a refused import creates no destination item');
  }
  const head = destinationProject.git(destinationProject.repo, 'rev-parse', 'HEAD');
  /** Freeze a real private Git revision before replaying identical claim bytes on both replicas. */
  const freeze = item => {
    const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion,
      check: item.item_check, rows: [], policy: { version: 1, commit: head, verify: { policy: 'any', family: 'off' } } });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
  const claim = prepareEngineMove(destination, 'claim', [records[0].destinationItemId,
    { agentId: web, lane: 'web', leaseMs: 60_000, freeze, head }]); // budget: a live authority fixture, not an elapsed-time assertion.
  const claimReceipt = { sequence: appliedSequence(destination) + 1, at: new Date().toISOString() };
  const claimed = [destination, peer].map(board => applyEngineMove(board, claim, claimReceipt));
  assert.deepEqual(claimed[0], claimed[1]);
  assert.equal(claimed[0].error, undefined, JSON.stringify(claimed[0]));
  assert.equal(apply(records[2], web).outcome.error?.code, 'AGENT_GRANT_ITEM',
    'holding one item cannot authorize creation of another through a rehome operation');
  for (const board of [destination, peer]) {
    assert.equal(board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(records[2].destinationItemId), undefined);
    const before = exportBoard(board);
    assert.deepEqual(applyEngineMove(board, allowed.move, allowed.receipt), allowed.outcome,
      'an exact historical receipt remains replayable after authority narrows');
    assert.deepEqual(exportBoard(board), before, 'exact replay does not append another event or item');
  }
});
