/** Private, live-shaped read workload: nineteen aliases, forty thousand shouts and 1,500 items [B7,C7]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as store from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../board.js';

let cleanup;
const setupStarted = performance.now();
const board = fixtureBoard({ after: callback => { cleanup = callback; } });
try {
  store.register(board, { lane: 'coordinator', path: '/scale/root' });
  const seats = Array.from({ length: 19 }, (_, index) => store.register(board,
    { lane: 'web', path: `/scale/worker-${index}`, session: 'private-scale-worker' }));
  const outsider = store.register(board, { lane: 'api', path: '/scale/outsider', session: 'private-scale-outsider' });
  const at = '2026-10-27T00:00:00.000Z';
  // Bulk inserts seed only this disposable fixture, rather than measuring forty thousand write moves.
  board.db.exec('BEGIN');
  board.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500)
    INSERT INTO item(item_lane,item_title,item_created_by,item_created_at,item_updated_at)
    SELECT CASE WHEN i%2=0 THEN 'api' ELSE 'web' END,'History item ' || i,'coordinator',?,? FROM n`).run(at, at);
  board.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<40000)
    INSERT INTO shout(shout_from,shout_to,shout_text,shout_at)
    SELECT 'coordinator',CASE WHEN i%1000=0 THEN 'item:2' ELSE ? END,'Historical message ' || i,? FROM n`).run(outsider, at);
  const cursor = board.db.prepare('UPDATE agent SET agent_last_shout_id=39000 WHERE agent_id=?');
  for (const seat of seats.slice(2)) cursor.run(seat);
  board.db.exec('COMMIT');
  for (const [id, agentId, lane] of [[1, seats[0], 'web'], [2, outsider, 'api']]) {
    store.claim(board, id, { agentId, lane, leaseMs: 3_600_000,
      freeze: () => ({ text: 'Private history fixture', digest: 'history-fixture' }) });
  }
  const lanes = ['coordinator', 'web', 'api'];
  const expected = [
    store.shout(board, { from: 'coordinator', to: seats[17], text: 'Alias instruction', lanes }),
    store.shout(board, { from: 'coordinator', to: 'web', text: 'Lane instruction', lanes }),
    store.shout(board, { from: 'coordinator', to: 'web', item: 1, text: 'Item instruction', lanes }),
  ];
  store.shout(board, { from: 'coordinator', to: 'api', item: 2, text: 'Outside item', lanes });
  store.shout(board, { from: seats[4], to: 'all', text: 'Suppressed self mail', lanes });
  // Historical malformed targets must not acquire a role merely because their numeric prefix parses.
  const malformed = board.db.prepare('INSERT INTO shout(shout_from,shout_to,shout_text,shout_at) VALUES (?,?,?,?)');
  for (const target of ['item:01', 'item:1suffix']) malformed.run('coordinator', target, 'Noncanonical', at);
  const timings = {};
  process.stderr.write(JSON.stringify({ phase: 'seeded', setupMs: performance.now() - setupStarted }) + '\n');
  /** Time only the actual read, excluding fixture setup and assertion work. */
  function timed(name, read) {
    const start = performance.now();
    const value = read();
    timings[name] = performance.now() - start;
    process.stderr.write(JSON.stringify({ phase: name, ms: timings[name] }) + '\n');
    return value;
  }
  assert.deepEqual(timed('previewMs', () => store.inbox(board, seats[0], { markRead: false }))
    .map(row => row.shout_id), expected);
  assert.equal(timed('countMs', () => store.unreadCount(board, seats[18])), expected.length);
  assert.deepEqual(timed('peekMs', () => store.peekShouts(board, seats[3], 10)).map(row => row.shout_id), expected);
  assert.deepEqual(timed('inboxMs', () => store.inbox(board, seats[5])).map(row => row.shout_id), expected);
  for (const seat of seats) assert.equal(store.unreadCount(board, seat), 0);
  process.stdout.write(JSON.stringify({ seats: seats.length, historicalShouts: 40000, items: 1500,
    expected, ...timings }) + '\n');
} finally { cleanup(); }
