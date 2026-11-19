/** A loop over every seat reads families from one snapshot, not one event query per seat [C7,#3251]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { seatFamily } from '../../../index.js';
import { withFamilyReads } from '../../../index.js';

const SEATS = 1_900;

/** Seed SEATS joined seats; every fifth also has a family event, and pairs share a session. */
function seed(owner) {
  const board = owner.board ?? owner;
  const meta = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  const seat = board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES(?,?,?,?,?)');
  const event = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,event_detail) VALUES(?,?,?,?)');
  board.db.exec('BEGIN');
  for (let n = 0; n < SEATS; n++) {
    seat.run(`core-${n}`, 'core', `/fixture/core-${n}`, null, '2026-11-04T00:00:00Z');
    meta.run(`agent_session:core-${n}`, `session-${n >> 1}`);
    event.run('2026-11-04T00:00:00Z', `core-${n}`, 'join', JSON.stringify(n % 3 ? {} : { family: n % 2 ? 'OpenAI' : 'Claude' }));
    if (n % 5 === 0) event.run('2026-11-04T00:00:01Z', `core-${n}`, 'family', JSON.stringify({ family: 'Gemini' }));
  }
  board.db.exec('COMMIT');
}

test('items.declaration.seat-records-budget: clause 1: inbox, status and heartbeat on a board with 1,900 agent rows spend under 100 ms in seatRecords [C7,#3251]', t => {
  const board = cellBoard(t, ':memory:');
  seed(board);
  const ids = Array.from({ length: SEATS }, (_, n) => `core-${n}`);
  const expected = ids.map(id => seatFamily(board, id));
  assert.ok(expected.some(Boolean), 'the fixture derives some families');
  const prepared = [];
  const prepare = board.db.prepare;
  board.db.prepare = sql => { prepared.push(sql); return prepare.call(board.db, sql); };
  let scoped, elapsed;
  try {
    const start = performance.now();
    scoped = withFamilyReads(board, () => ids.map(id => seatFamily(board, id)));
    elapsed = performance.now() - start;
  } finally { delete board.db.prepare; }
  assert.deepEqual(scoped, expected, 'the snapshot derives the same family for every seat');
  assert.ok(prepared.length < 20, `${prepared.length} statements prepared for ${SEATS} seats`);
  assert.ok(elapsed < 100, `${SEATS} seats took ${elapsed.toFixed(1)} ms`); // budget: ceiling declared by #3251's frozen bar
});
