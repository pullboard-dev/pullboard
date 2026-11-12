/** Landing order comes from one grouped accept query, never a read of the whole event log [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates } from '../../../../packages/landing/src/io/step/selection.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';

const EVENTS = 237_000;

/** Fill the real event table with a mix of kinds; every 50th row accepts one of 40 items, so some items accept twice. */
function seed(board) {
  const insert = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,event_detail,item_id) VALUES(?,?,?,?,?)');
  board.db.exec('BEGIN');
  for (let index = 0; index < EVENTS; index++) {
    const accept = index % 50 === 0;
    insert.run('2026-11-01T00:00:00Z', 'fixture', accept ? 'accept' : 'note', '{}', accept ? (index / 50) % 40 + 1 : null);
  }
  board.db.exec('COMMIT');
}

/** The board with every prepared statement recorded, so a test sees which queries a call ran. */
function spied(board, seen) {
  const db = new Proxy(board.db, { get: (target, key) => key === 'prepare' ? sql => { seen.push(String(sql)); return target.prepare(sql); } : target[key]?.bind?.(target) ?? target[key] });
  return { ...board, db };
}

test('candidates() reads accept order with one grouped SQL query and never selects the whole event log [C7]', t => {
  const board = fixtureBoard(t);
  seed(board);
  const seen = [];
  candidates(spied(board, seen), process.cwd(), 'HEAD', 1, { listItems: () => [], landingPorts: {} });
  const grouped = seen.filter(sql => /GROUP BY item_id/u.test(sql));
  assert.equal(grouped.length, 1, 'candidates() ran the grouped query once');
  assert.ok(!seen.some(sql => /FROM event ORDER BY/u.test(sql)), 'candidates() never ran a whole-log select');
});

test('on a 237,000-event board candidates() takes under 50 ms [C7]', t => {
  const board = fixtureBoard(t);
  seed(board);
  const run = () => candidates(board, process.cwd(), 'HEAD', 1, { listItems: () => [], landingPorts: {} });
  run();
  const start = performance.now();
  run();
  const ms = performance.now() - start;
  assert.ok(ms < 50, `candidates took ${ms.toFixed(1)} ms`); // budget: declared by the item's bar, 50 ms measured on 237,000 events.
});
