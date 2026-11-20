/** The store reads the frozen pace through one reader, so the merged writer and the verify snapshot take a sprint item's sprint rows and leave steady and strict as they were [V2,M1,#12173]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemPace } from '../../../index.js';
import { merged } from '../../../index.js';
import { getItem } from '../../../index.js';
import { verifySnapshot } from '../../../src/io/board/verify-table.js';
import { cellBoard } from '../../fixtures/cell.js';

const AT = Date.parse('2026-11-19T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const COMMIT = 'c'.repeat(40);
const FROZEN = { sprint: JSON.stringify({ criterion: '1. It works [test]', pace: 'sprint' }), strict: JSON.stringify({ criterion: '1. It works [test]', pace: 'strict' }), steady: JSON.stringify({ criterion: '1. It works [test]' }) };

/** A board with item 7 in `status`, its bar frozen under `pace`; a verified item carries the ACCEPT the board's verified rule needs. */
function boardWith(t, status, pace) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'paced', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  if (status === 'verified') board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run('a'.repeat(40), 'd'.repeat(64), 'a'.repeat(40), STAMP);
  // The status guard admits a write only while the move token is set, as moveItem sets it, so the fixture states the item this way.
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status=?, item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen=?, item_frozen_digest=?, item_built_by='core-1', item_verified_by=?, item_verdict=? WHERE item_id=7`)
    .run(status, 'a'.repeat(40), FROZEN[pace], 'd'.repeat(64), status === 'verified' ? 'core-2' : null, status === 'verified' ? 'ACCEPT' : null);
  board.db.exec('DELETE FROM temp.moving');
  return board;
}

/** Try the coordinator's plain merge of item 7: the refusal code, or 'merged' with the commit the board now holds. */
function tryMerge(board) {
  try { merged(board, 7, { agentId: 'coordinator', commit: COMMIT }); } catch (error) { return { code: error.code, message: error.message }; }
  return { code: 'merged', commit: getItem(board, 7).item_merged_commit };
}

/** The facts readVerifyFacts would hand the snapshot, fixed so the snapshot is compared on the item row alone. */
const FACTS = Object.freeze({ route: 'strong', family: null, sharpenToPerson: false, history: [], verdicts: [], flakes: [], nextEventId: 1, nextVerdictId: 1 });
const CALL = Object.freeze({ agentId: 'core-2', decision: 'ACCEPT', note: 'fixture' });

/** Count the board statements prepared while `run` runs. */
function statements(board, run) {
  const prepare = board.db.prepare.bind(board.db);
  let count = 0;
  board.db.prepare = (sql) => { count += 1; return prepare(sql); };
  try { run(); } finally { board.db.prepare = prepare; }
  return count;
}

test('store.sprint-pace.merged-takes-sprint-row: clause 1: the one exported reader reads sprint, steady or strict from the frozen bar, and the merged writer lands a submitted sprint item by the sprint row instead of refusing NOT_VERIFIED [V2,M1,#12173]', t => {
  assert.equal(itemPace({ item_frozen: FROZEN.sprint }), 'sprint');
  assert.equal(itemPace({ item_frozen: FROZEN.strict }), 'strict');
  assert.equal(itemPace({ item_frozen: FROZEN.steady }), 'steady', 'a bar frozen with no pace is steady');
  assert.equal(itemPace({ item_frozen: null }), 'steady', 'an item never frozen is steady');
  assert.equal(itemPace({ item_frozen: '{not json' }), 'steady', 'a damaged frozen bar reads as steady');
  assert.deepEqual(tryMerge(boardWith(t, 'submitted', 'sprint')), { code: 'merged', commit: COMMIT }, 'a submitted sprint item lands with no verdict');
  assert.deepEqual(tryMerge(boardWith(t, 'verified', 'sprint')), { code: 'merged', commit: COMMIT }, 'a verified sprint item still lands');
  const open = tryMerge(boardWith(t, 'open', 'sprint'));
  assert.equal(open.code, 'NOT_VERIFIED', 'sprint still refuses work that was never submitted');
  assert.match(open.message, /under sprint merge submitted or verified work only/u, 'the refusal is the sprint row submitted');
});

test('store.sprint-pace.verify-snapshot-carries-pace: clause 1: the verify table snapshot of a sprint item carries pace sprint, so the table runs it under sprint [V2,M1,#12173]', t => {
  const board = boardWith(t, 'submitted', 'sprint');
  const snapshot = verifySnapshot(board, getItem(board, 7), CALL, FACTS, {});
  assert.equal(snapshot.pace, 'sprint');
  assert.equal(snapshot.item.status, 'submitted');
});

test('store.sprint-pace.steady-unchanged: clause 2: a steady or strict item gets the merged decision, refusals and verify snapshot it got before (no pace key), and the pace adds no board statement [V2,M1,#12173]', t => {
  for (const pace of ['steady', 'strict']) {
    const submitted = tryMerge(boardWith(t, 'submitted', pace));
    assert.deepEqual(submitted, { code: 'NOT_VERIFIED', message: '[NOT_VERIFIED] item #7 is submitted; merge verified work only' }, `${pace}: submitted work is refused as before`);
    assert.deepEqual(tryMerge(boardWith(t, 'verified', pace)), { code: 'merged', commit: COMMIT }, `${pace}: verified work lands as before`);
    const board = boardWith(t, 'submitted', pace);
    const snapshot = verifySnapshot(board, getItem(board, 7), CALL, FACTS, {});
    assert.equal(Object.hasOwn(snapshot, 'pace'), false, `${pace}: the verify snapshot carries no pace key`);
  }
  // The pace is read from the item row already loaded: a sprint merge and snapshot prepare exactly the statements a steady one does.
  const count = (pace) => {
    const board = boardWith(t, 'verified', pace);
    const item = getItem(board, 7);
    return { merge: statements(board, () => merged(board, 7, { agentId: 'coordinator', commit: COMMIT })), snapshot: statements(board, () => verifySnapshot(board, item, CALL, FACTS, {})) };
  };
  const steady = count('steady');
  assert.deepEqual(count('sprint'), steady, 'reading the pace adds no board statement');
  assert.equal(steady.snapshot, 0, 'the verify snapshot reads no board statement');
});
