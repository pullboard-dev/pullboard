/** The store's merged writer runs the landing merged table: what it writes and refuses agrees with the table on every replayed merge [C7,#8268]. */
/** @pullboard-test-input packages/store/src/io/board/merged.js packages/store/src/io/board/merged-table.js packages/store/src/logic/board/landing/lease.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const COMMIT = 'c'.repeat(40);

/** A board with one item in `status`, so a merge can be tried from any state. */
function boardWith(t, status) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  // The board's verified rule needs an ACCEPT on the frozen criterion, by a verifier other than the builder, at the item's commit.
  if (status === 'verified') board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run('a'.repeat(40), 'd'.repeat(64), 'a'.repeat(40), STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status=?, item_commit=?, item_owner=?, item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by=?, item_verdict=? WHERE item_id=7`)
    .run(status, status === 'open' ? null : 'a'.repeat(40), status === 'open' ? null : 'core-1', 'd'.repeat(64), status === 'verified' ? 'core-2' : null, status === 'verified' ? 'ACCEPT' : null);
  board.db.exec('DELETE FROM temp.moving');
  return board;
}

/** The merge and withdraw events written for the item, as plain objects. */
const written = board => board.db.prepare("SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE item_id=7 AND event_kind IN ('merged','withdraw') ORDER BY event_id").all()
  .map(({ kind, by, detail }) => ({ kind, by, detail: JSON.parse(detail) }));

/** Stand in for the injected tables, so a test can make the landing table refuse or throw. */
function tableSays(answer) {
  store.provideMoveTables({ runTable: () => answer(), landingEngine: () => ({ tables: { merged: {} }, rules: {} }) });
}

test('clause 1: the merged writer writes the events the landing merged table decides, on every replayed merge [C7,#8268]', t => {
  const replays = [
    { status: 'verified', call: { agentId: 'coordinator', commit: COMMIT } },
    { status: 'verified', call: { agentId: 'coordinator', commit: COMMIT, forced: 'landed around the gate', waiveProof: 'no run' } },
    { status: 'open', call: { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'no run' } },
    { status: 'submitted', call: { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'no run' } },
  ];
  for (const { status, call } of replays) {
    const board = boardWith(t, status);
    const decided = store.mergedDecision({ id: 7, status, mergedCommit: null }, call);
    assert.ok(decided?.events?.length, `the table decided the ${status} merge`);
    store.merged(board, 7, call);
    const wrote = written(board);
    assert.deepEqual(wrote.map(event => event.kind), decided.events.map(event => event.kind), `${status}: the same events in the same order`);
    for (const [index, event] of decided.events.entries()) {
      assert.equal(wrote[index].by, event.by);
      for (const [key, value] of Object.entries(event.detail)) assert.deepEqual(wrote[index].detail[key], value, `${status}: the written ${key} is the table's`);
    }
  }
});

test('clause 1: a merge the table refuses is refused with the table\'s code and writes nothing [C7,#8268]', t => {
  const board = boardWith(t, 'open');
  assert.throws(() => store.merged(board, 7, { agentId: 'coordinator', commit: COMMIT }), error => error.code === 'NOT_VERIFIED');
  assert.equal(written(board).length, 0);
  tableSays(() => ({ refused: { code: 'COORDINATOR_ONLY', message: 'only the coordinator records merges', next: 'ask the coordinator' } }));
  const verified = boardWith(t, 'verified');
  assert.throws(() => store.merged(verified, 7, { agentId: 'coordinator', commit: COMMIT }), error => error.code === 'COORDINATOR_ONLY' && error.next === 'ask the coordinator');
  assert.equal(written(verified).length, 0);
});

test('clause 1: a landing table that throws never takes the merge down; the writer\'s own rules stand [C7,#8268]', t => {
  tableSays(() => { throw new Error('table broke'); });
  const board = boardWith(t, 'verified');
  store.merged(board, 7, { agentId: 'coordinator', commit: COMMIT });
  assert.equal(written(board).length, 1);
  assert.throws(() => store.merged(boardWith(t, 'open'), 7, { agentId: 'coordinator', commit: COMMIT }), error => error.code === 'NOT_VERIFIED');
});
