/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js packages/state/src/io/machine.js */
/** Replay actual released-engine receipts against the current engine [V1,H3,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../index.js';
import { openCellBoard as openBoard } from './fixtures/cell.js';
import {
  appliedSequence,
  applyRelayMove,
  engineReceipt,
  prepareEngineMove,
} from '../../state/index.js';
import {
  exportBoard,
  importBoard,
} from '../index.js';
import { unpackRelease } from '../../../apps/cli/tests/fixtures/release/archive.js';

// The immutable v0.8.6 release, rather than current source with an old engine tag.
const RELEASE = '0f86cb6cd615200a91b9aa8d79b86841f3045ca3';
const GENERIC_NEXT = 'Run pullboard help, correct the reported problem, and retry the command.';

test('an engine-8 NOT_VERIFIED merge refusal replays unchanged [V1,H3,H16]', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-engine8-merge-'));
  const client = join(directory, 'v0.8.6');
  mkdirSync(client);
  let source;
  let replica;
  let legacyStore;
  t.after(() => {
    if (source) legacyStore.closeBoard(source);
    if (replica) store.closeBoard(replica);
    rmSync(directory, { recursive: true, force: true });
  });

  unpackRelease(RELEASE, client);
  legacyStore = await import(pathToFileURL(join(client, 'src/board.js')).href);
  const legacyEngine = await import(pathToFileURL(join(client, 'src/engine.js')).href);
  const legacyExchange = await import(pathToFileURL(join(client, 'src/exchange.js')).href);
  const legacyMachine = await import(pathToFileURL(join(client, 'src/machine.js')).href);
  assert.equal(legacyMachine.ENGINE_VERSION, 8);
  source = legacyStore.openBoard(join(directory, 'source.sqlite'));
  legacyStore.register(source, { lane: 'coordinator', path: '/fixture/coordinator' });
  const item = legacyStore.addItem(source, {
    by: 'coordinator', lane: 'web', title: 'Open replay fixture', criterion: 'the page renders',
  });
  assert.equal(legacyStore.getItem(source, item).item_status, 'open');
  replica = openBoard(join(directory, 'replica.sqlite'));
  importBoard(replica, legacyExchange.exportBoard(source));
  const before = exportBoard(replica);
  const move = legacyEngine.prepareEngineMove(source, 'merged', [item, {
    agentId: 'coordinator', commit: 'a'.repeat(40),
  }], { id: 'engine8-open-item-merge', actor: 'coordinator' });
  assert.equal(move.engine, 8, 'the real released engine produces the envelope');
  assert.equal(move.operation, 'merged');
  assert.equal(engineReceipt(replica, move.id), null, 'replay must execute on a fresh replica');
  const order = { sequence: 1, at: '2026-10-16T12:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };
  const recorded = legacyEngine.applyRelayMove(source, move, order);
  assert.equal(recorded.error.code, 'NOT_VERIFIED');
  assert.equal(recorded.error.message, `item #${item} is open; merge verified work only`);
  assert.equal(recorded.error.next, GENERIC_NEXT, 'the old executable records its historical next step');

  const replayed = applyRelayMove(replica, move, order);
  assert.equal(JSON.stringify(replayed), JSON.stringify(recorded), 'the whole refusal replays byte for byte');
  const after = exportBoard(replica);
  for (const [table, rows] of Object.entries(before.tables)) {
    if (table !== 'board_meta') assert.deepEqual(after.tables[table], rows, `refusal leaves ${table} unchanged`);
  }
  const receiptKeys = new Set(['relay_receipt_' + move.id, 'relay_applied_sequence', 'relay_engine_version']);
  assert.deepEqual(after.tables.board_meta.filter(row => !receiptKeys.has(row.meta_key)),
    before.tables.board_meta.filter(row => !receiptKeys.has(row.meta_key)), 'only receipt metadata changes');
  assert.equal(appliedSequence(replica), 1);
  const receipt = engineReceipt(replica, move.id);
  assert.equal(JSON.stringify(receipt), JSON.stringify(legacyEngine.engineReceipt(source, move.id)),
    'the complete persisted receipts also match');
  assert.equal(JSON.stringify(applyRelayMove(replica, move, order)), JSON.stringify(recorded),
    'a duplicate returns the same stored refusal');
  assert.deepEqual(exportBoard(replica), after, 'a duplicate does not change the replica');
  const currentMove = prepareEngineMove(replica, 'merged', [item, {
    agentId: 'coordinator', commit: 'b'.repeat(40),
  }], { id: 'current-open-item-merge', actor: 'coordinator' });
  const current = applyRelayMove(replica, currentMove, { ...order, sequence: 2 });
  assert.equal(current.error.code, 'NOT_VERIFIED');
  assert.equal(current.error.next, 'merge verified work only', 'new envelopes retain current guidance');
});
