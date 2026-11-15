/** Replaying the lease table over the landing events a real board recorded agrees on every move, and a doctored log is reported with its event id [C7,#8164]. */
// fixture-subject: addItem (a store unit test of the landing lease over a real in-memory board)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { replayLandingMoves } from '../../../../packages/moves/index.js';

const START = Date.parse('2026-11-10T00:00:00Z');

/** A real in-memory board with a private clock; every lease move below is the store's own, and every event is what it wrote. */
function fixture(t) {
  let at = START;
  const board = openBoard(':memory:', { now: () => new Date(at) });
  store.register(board, { lane: 'coordinator', path: process.cwd() });
  t.after(() => store.closeBoard(board));
  const lander = () => ({ agentId: 'coordinator', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid });
  const move = (who, action, extra = {}) => store.landingLeaseMove(board, { ...who, action, ...extra });
  return { board, lander, move, advance(ms) { at += ms; } };
}

test('replaying real recorded landing moves (acquire, queue, release, expire-and-reclaim) agrees with the lease table on every move [C7,#8164]', t => {
  const box = fixture(t);
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(box.lander);
  const first = box.move(a, 'request');
  assert.equal(first.acquired, true);
  box.move(b, 'request');
  box.move(c, 'request');
  box.advance(30_000);
  box.move(a, 'request');
  box.move(a, 'release', { generation: first.generation });
  box.advance(1000);
  assert.equal(box.move(b, 'request').acquired, true);
  box.advance(130_000);
  const reclaimed = box.move(d, 'request');
  assert.equal(reclaimed.acquired, true, 'the expired holder b and the stale waiter c are passed');
  box.move(e, 'request');
  box.move(d, 'release', { generation: reclaimed.generation });
  box.move(e, 'request');
  const events = box.board.db.prepare("SELECT count(*) AS n FROM event WHERE event_kind = 'landing_lease'").get().n;
  const report = replayLandingMoves(box.board, { since: new Date(START - 1000).toISOString() });
  assert.ok(events >= 8, `the board recorded ${events} lease events`);
  assert.deepEqual([report.total, report.agreed, report.disagreed, report.notReplayable], [events, events, 0, 0], JSON.stringify(report.disagreements));
});

test('a lease event that contradicts the table (a second holder at the same generation) is reported with its event id [C7,#8164]', t => {
  const box = fixture(t);
  const [a, b] = [1, 2].map(box.lander);
  box.move(a, 'request');
  box.move(b, 'request');
  box.advance(1000);
  store.logEvent(box.board, 'coordinator', 'landing_lease', null, { action: 'request', token: b.token, holder: `coordinator landing ${a.token.slice(0, 8)}`, generation: 2, queued: 1 });
  const row = box.board.db.prepare("SELECT max(event_id) AS id FROM event").get();
  const report = replayLandingMoves(box.board, { since: new Date(START - 1000).toISOString() });
  assert.deepEqual([report.agreed, report.disagreed], [2, 1]);
  assert.deepEqual([report.disagreements[0].event, report.disagreements[0].differs], [row.id, 'detail']);
});
