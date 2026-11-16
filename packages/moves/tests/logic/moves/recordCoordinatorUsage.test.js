/** The coordinator usage move is an ordered move floored at its own engine that stores one coordinator row [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COORDINATOR_USAGE_ENGINE } from '../../../../state/index.js';
import { applyRelayMove } from '../../../../state/index.js';
import { prepareEngineMove } from '../../../../state/index.js';
import { MOVE_REGISTRY } from '../../../index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { FIXTURE_MODEL } from '../../../../gate/tests/fixtures/testkit.js';

const RECORDS = [{ model: FIXTURE_MODEL, inputTokens: 9, outputTokens: 4, wallMs: 0, knownInputTokens: 9, knownOutputTokens: 4,
  freshInputTokens: 2, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, unknownReasons: [] }];

test('recordCoordinatorUsage is declared at the coordinator engine with the authenticated seat as actor [C7]', () => {
  const declaration = MOVE_REGISTRY.recordCoordinatorUsage;
  assert.equal(declaration.engine, COORDINATOR_USAGE_ENGINE);
  assert.equal(declaration.minimumEngine([{ agentId: 'coordinator' }]), COORDINATOR_USAGE_ENGINE);
  assert.equal(declaration.actor({ args: [{ agentId: 'coordinator' }] }), 'coordinator');
  assert.equal(declaration.itemIdFirstArgument, false);
});

test('the prepared move runs the store function and a replay changes nothing [C7]', t => {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const move = prepareEngineMove(board, 'recordCoordinatorUsage', [{ agentId: 'coordinator', session: 's-1', records: RECORDS, observedAt: 5 }]);
  assert.equal(move.operation, 'recordCoordinatorUsage');
  assert.ok(move.engine >= COORDINATOR_USAGE_ENGINE);
  const transport = { kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' }, sequence: 1, at: '2026-10-09T12:00:00.000Z' };
  applyRelayMove(board, move, transport);
  const row = JSON.parse(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='coordinator:s-1'").get().meta_value);
  assert.equal(row.agent, 'coordinator');
  assert.equal(row.records[0].outputTokens, 4);
  const receipts = board.db.prepare("SELECT item_id, event_by FROM event WHERE event_kind='coordinator-usage'").all();
  assert.deepEqual(receipts.map(row => ({ ...row })), [{ item_id: null, event_by: 'coordinator' }]);
  const stored = () => board.db.prepare("SELECT * FROM board_meta WHERE meta_key LIKE 'coordinator:%'").all();
  const before = stored();
  applyRelayMove(board, { ...move, id: 'replay' }, { ...transport, sequence: 2 });
  assert.deepEqual(stored(), before);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='coordinator-usage'").get().n, 1);
});
