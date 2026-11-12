/** seatFamily reads its session peers through an index on a board_meta of production scale [C7,#2976]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../../apps/cli/tests/fixtures/board.js';
import { seatFamily } from '../../../index.js';

const ROWS = 300_000;
const SEATS = 100;

/**
 * Seed a board_meta of ROWS rows shaped like the real board: half `local:` keys and half `agent_` keys, a third
 * of those session records, plus SEATS joined seats that each share a session with one ghost peer.
 */
function seed(board) {
  const meta = board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  const seat = board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES(?,?,?,?,?)');
  const event = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,event_detail) VALUES(?,?,?,?)');
  board.db.exec('BEGIN');
  try {
    for (let n = 0; n < SEATS; n++) {
      seat.run(`core-${n}`, 'core', `/fixture/core-${n}`, null, '2026-11-04T00:00:00Z');
      meta.run(`agent_session:core-${n}`, `session-${n}`);
      meta.run(`agent_session:ghost-${n}`, `session-${n}`);
      event.run('2026-11-04T00:00:00Z', `core-${n}`, 'join', JSON.stringify({ family: n % 2 ? 'OpenAI' : 'Claude' }));
    }
    for (let n = board.db.prepare('SELECT COUNT(*) AS n FROM board_meta').get().n; n < ROWS; n++) {
      if (n % 2) meta.run(`local:filler-${n}`, 'x');
      else meta.run(n % 3 ? `agent_creator:filler-${n}` : `agent_session:filler-${n}`, `filler-session-${n % 7919}`);
    }
    board.db.exec('COMMIT');
  } catch (error) {
    board.db.exec('ROLLBACK');
    throw error;
  }
}

/** Record every SQL text seatFamily prepares, by shadowing prepare on this one connection. */
function preparedBy(board, run) {
  const seen = new Set();
  const prepare = board.db.prepare;
  board.db.prepare = sql => { seen.add(sql); return prepare.call(board.db, sql); };
  try { run(); } finally { delete board.db.prepare; }
  return [...seen];
}

test('seatFamily plans no board_meta scan and 1,000 calls finish under 50 ms on 300,000 rows [C7,#2976]', t => {
  const board = fixtureBoard(t);
  seed(board);
  assert.ok(board.db.prepare('SELECT COUNT(*) AS n FROM board_meta').get().n >= ROWS);
  const expected = n => n % 2 ? 'OpenAI' : 'Claude';
  const queries = preparedBy(board, () => assert.equal(seatFamily(board, 'core-1'), 'OpenAI'));
  const plans = queries.map(sql => {
    const marks = sql.match(/\?/gu)?.length ?? 0;
    return board.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(marks).fill('x')).map(row => row.detail);
  });
  assert.ok(queries.some(sql => sql.includes('board_meta')), 'seatFamily reads board_meta');
  for (const [n, details] of plans.entries()) {
    assert.ok(!details.some(detail => /^SCAN board_meta\b/u.test(detail)), `full board_meta scan in: ${queries[n]}\n${details.join('\n')}`);
  }
  const peers = plans[queries.findIndex(sql => sql.includes('meta_value=?'))];
  assert.ok(peers.some(detail => /SEARCH board_meta USING INDEX board_meta_agent_session_value_v1 \(meta_value=\?\)/u.test(detail)), peers.join('\n'));
  for (let n = 0; n < SEATS; n++) assert.equal(seatFamily(board, `core-${n}`), expected(n));
  const started = performance.now();
  for (let call = 0; call < 1000; call++) seatFamily(board, `core-${call % SEATS}`);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `1,000 seatFamily calls took ${elapsed.toFixed(1)} ms`); // budget: ceiling declared by #2976's frozen bar
});
