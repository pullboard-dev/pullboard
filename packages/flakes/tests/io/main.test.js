import { flakeLedger as nativeFlakeLedger } from '../../index.js';
import { recordFlakeObservation as nativeRecordFlakeObservation } from '../../index.js';
/** Synthetic public-store/replay fixtures: these receipt inputs do not claim a gate was executed [H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../../../store/tests/fixtures/cell.js';
import {
  applyEngineMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../store/index.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';

/** Seed only a private in-memory board, using ordinary registration operations and a controlled clock. */
function ledgerFixture(t) {
  let time = Date.parse('2026-10-20T00:00:00Z');
  const board = openBoard(':memory:', { now: () => new Date(time) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/synthetic/main' });
  const builder = store.register(board, { lane: 'app', path: '/synthetic/build', route: 'strong' });
  const reviewer = store.register(board, { lane: 'app', path: '/synthetic/review', route: 'strong' });
  return { board, builder, reviewer, advance: () => { time += 1000; }, at: () => new Date(time).toISOString() };
}

/** Make bounded synthetic receipt metadata solely for validation, ledger and replay contracts. */
function observation(box, id) {
  const receipt = green => {
    const bytes = Buffer.from(green ? 'synthetic green receipt' : 'synthetic red receipt');
    return { green, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      artifact: 'flake-evidence/' + id + '/' + (green ? 'paired' : 'original') + '.log', profileSha256: null };
  };
  return { id, file: 'app/test.test.js', name: 'synthetic ledger target', head: 'a'.repeat(40), tree: 'b'.repeat(40), main: 'a'.repeat(40),
    kind: 'check', classification: 'flake', reason: 'Synthetic unit fixture only; no gate run is claimed.', commandSha256: 'c'.repeat(64),
    at: box.at(), diagnosticMs: 1, load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, original: receipt(false), paired: receipt(true), mainReceipt: null };
}

/** Exercise the public observation operation with the same lane and registered actor as an actual adapter. */
function record(box, value) { return nativeRecordFlakeObservation(box.board, { agentId: box.builder, observation: value, lane: 'app' }); }

test('one observation is immutable and idempotent; the first files one ordinary repair item and a second joins it [D1,H16]', t => {
  const box = ledgerFixture(t), first = observation(box, 'synthetic-one');
  record(box, first);
  const count = store.events(box.board).length;
  assert.equal(record(box, first).duplicate, true);
  assert.equal(store.events(box.board).length, count);
  assert.equal(nativeFlakeLedger(box.board)[0].count, 1);
  const repairId = nativeFlakeLedger(box.board)[0].item, drafted = store.getItem(box.board, repairId);
  assert.equal(drafted.item_status, 'open'); assert.equal(drafted.item_route, 'strong');
  assert.match(drafted.item_brief, /synthetic-one/u);
  assert.throws(() => record(box, { ...first, reason: 'different evidence under an existing identity' }), error => error.code === 'FLAKE_OBSERVATION_CHANGED');
  box.advance(); record(box, observation(box, 'synthetic-two'));
  const row = nativeFlakeLedger(box.board)[0];
  assert.equal(row.count, 2); assert.equal(row.observations.length, 2);
  assert.equal(row.item, repairId, 'the second sighting joins the open repair item');
  assert.equal(store.listItems(box.board).filter(item => /^Flaky test:/u.test(item.item_title)).length, 1);
  assert.ok(!store.events(box.board).some(event => /row_decision|doctrine/u.test(event.event_kind)), 'drafting never approves governing rows');
});

test('a landed repair is fixed until the same test is seen again [D1,H16]', t => {
  const box = ledgerFixture(t);
  record(box, observation(box, 'synthetic-one')); box.advance(); record(box, observation(box, 'synthetic-two'));
  const row = nativeFlakeLedger(box.board)[0], id = row.item;
  store.claim(box.board, id, { agentId: box.builder, lane: 'app', leaseMs: 3600000,
    freeze: () => ({ text: 'synthetic repair criterion', digest: 'd'.repeat(64) }) });
  submitFixture(box.board, id, { agentId: box.builder, commit: 'e'.repeat(40), tree: 'f'.repeat(40) });
  store.verify(box.board, id, { agentId: box.reviewer, decision: 'ACCEPT', head: 'e'.repeat(40), digest: 'd'.repeat(64), policy: 'any',
    note: 'Synthetic history fixture: no engineering acceptance or gate execution is claimed.' });
  box.advance(); store.merged(box.board, id, { agentId: 'coordinator', commit: '1'.repeat(40), note: 'Synthetic history only; no real repository changed.' });
  assert.equal(nativeFlakeLedger(box.board)[0].status, 'fixed');
  box.advance(); record(box, observation(box, 'synthetic-three'));
  const again = nativeFlakeLedger(box.board)[0];
  assert.equal(again.status, 'active'); assert.equal(again.count, 3);
  assert.equal(again.firstSeen, row.firstSeen); assert.ok(again.lastSeen > row.lastSeen);
});

test('flake observations replay exactly and duplicate engine receipts do not add sightings [H16]', t => {
  const box = ledgerFixture(t), replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(box.board));
  for (let sequence = 1; sequence <= 2; sequence++) {
    const move = prepareEngineMove(box.board, 'recordFlakeObservation', [{ agentId: box.builder, observation: observation(box, 'synthetic-' + sequence), lane: 'app' }],
      { id: 'synthetic-move-' + sequence, actor: box.builder });
    const order = { sequence, at: box.at() };
    const original = applyEngineMove(box.board, move, order), replayed = applyEngineMove(replica, move, order);
    assert.deepEqual(replayed, original);
    assert.deepEqual(applyEngineMove(replica, move, order), original, 'the duplicate returns its immutable engine receipt');
    box.advance();
  }
  assert.deepEqual(nativeFlakeLedger(replica), nativeFlakeLedger(box.board));
  assert.equal(nativeFlakeLedger(replica)[0].count, 2); assert.equal(appliedSequence(replica), 2);
  const source = exportBoard(box.board), target = exportBoard(replica);
  for (const [table, rows] of Object.entries(source.tables)) if (table !== 'board_meta') assert.deepEqual(target.tables[table], rows, table);
});

test('old engines, unjoined actors and impossible evidence cannot add observations [H16]', t => {
  const box = ledgerFixture(t), value = observation(box, 'synthetic-one');
  assert.throws(() => nativeRecordFlakeObservation(box.board, { agentId: 'not-joined', observation: value, lane: 'app' }), error => error.code === 'NOT_JOINED');
  assert.throws(() => record(box, { ...value, original: { ...value.original, green: true } }), error => error.code === 'FLAKE_EVIDENCE');
  const move = prepareEngineMove(box.board, 'recordFlakeObservation', [{ agentId: box.builder, observation: value, lane: 'app' }], { id: 'synthetic-old-engine', actor: box.builder });
  assert.throws(() => applyEngineMove(box.board, { ...move, engine: 58 }, { sequence: 1, at: box.at() }), error => error.code === 'RELAY_MOVE');
  box.board.executionEngineVersion = 58;
  try {
    assert.throws(() => record(box, value), error => error.code === 'ENGINE_VERSION');
    assert.throws(() => store.recordLandingBatch(box.board, { agentId: 'coordinator', batch: { flakeDiagnostics: {} } }), error => error.code === 'ENGINE_VERSION');
  } finally { delete box.board.executionEngineVersion; }
  assert.deepEqual(nativeFlakeLedger(box.board), []);
});
