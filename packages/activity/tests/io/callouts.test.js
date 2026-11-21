/** The coordinator's every-next call-out read stays on open rows and stays flat as answered shout history grows [C7]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { register } from '../../../store/index.js';
import { shout } from '../../../store/index.js';
import { coordinatorCalloutLine } from '../../index.js';

const ACTIONABLE = 'Sentinel needs a sharper bar';

/** Add deterministic call-out rows so the small and history-heavy boards differ only in irrelevant/answered rows. */
function seed(board, count) {
  const add = board.db.prepare(`INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_answers, shout_answered_at)
    VALUES (?, 'coordinator', ?, ?, ?, ?)`);
  for (let index = 0; index < count; index++) {
    const live = index === 0;
    const answered = !live && index % 2 === 0;
    const id = Number(add.run(live ? 'sentinel' : `seat-${index}`, live ? ACTIONABLE : `ordinary coordinator note ${index}`,
      '2026-11-20T00:00:00.000Z', answered ? 1 : null, answered ? '2026-11-20T00:01:00.000Z' : null).lastInsertRowid);
    if (answered) board.db.prepare('UPDATE shout SET shout_answers=? WHERE shout_id=?').run(id, id);
  }
}

/** Return the median duration of 20 identical coordinator call-out reads. */
function medianReadMs(board, nowMs) {
  for (let index = 0; index < 3; index++) coordinatorCalloutLine(board, nowMs);
  const times = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    coordinatorCalloutLine(board, nowMs);
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return (times[9] + times[10]) / 2;
}

test('activity.io-callouts.reads-open-callouts-by-index: clause 1: every prepared call-out statement has an indexed plan and none reads answered shout history [C7]', t => {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/m/coordinator' });
  seed(board, 10);
  const statements = [];
  const db = board.db;
  board.db = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => { statements.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.match(coordinatorCalloutLine(board, Date.parse('2026-11-20T01:00:00.000Z')), /1 unanswered call-out/u);
  board.db = db;
  assert.ok(statements.length > 0, 'the spy records the prepared statements');
  const shoutPlans = [];
  for (const sql of statements) {
    assert.doesNotMatch(sql, /SELECT\s+shout_answers\s+AS\s+id\s+FROM\s+shout\s+WHERE\s+shout_answers\s+IS\s+NOT\s+NULL/iu,
      'no statement loads answered shout ids');
    const params = Array.from(sql.matchAll(/\?/gu)).length;
    const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(params).fill(null)).map(row => row.detail);
    if (/\bFROM\s+shout\b/iu.test(sql)) shoutPlans.push(...details);
  }
  assert.ok(shoutPlans.length > 0, 'a shout query plan was captured');
  assert.ok(shoutPlans.some(detail => /shout_open_coordinator_callout/u.test(detail)), shoutPlans.join('\n'));
  assert.ok(shoutPlans.every(detail => !/SCAN shout(?! USING INDEX shout_open_coordinator_callout)/u.test(detail)), shoutPlans.join('\n'));
  const sentinel = register(board, { lane: 'core', path: '/m/sentinel' });
  const ask = shout(board, { from: sentinel, to: 'coordinator', text: ACTIONABLE, lanes: ['core'], decision: true });
  shout(board, { from: 'coordinator', to: sentinel, text: 'I have acted on the call-out', lanes: ['core'], answers: ask });
  assert.ok(db.prepare('SELECT shout_answered_at FROM shout WHERE shout_id=?').get(ask).shout_answered_at,
    'the answer write timestamps the call-out in the same transaction');
});

test('activity.io-callouts.cost-flat-with-shout-history: clause 2: 4,342 answered and unrelated coordinator shouts keep median read under 200 ms and within 2x of 10 rows [C7]', t => {
  const small = cellBoard(t, ':memory:');
  const large = cellBoard(t, ':memory:');
  register(small, { lane: 'coordinator', path: '/m/small-coordinator' });
  register(large, { lane: 'coordinator', path: '/m/large-coordinator' });
  seed(small, 10);
  seed(large, 4342);
  const nowMs = Date.parse('2026-11-20T01:00:00.000Z');
  const smallMedian = medianReadMs(small, nowMs);
  const largeMedian = medianReadMs(large, nowMs);
  assert.ok(largeMedian < 200, `history median ${largeMedian.toFixed(2)} ms must be under 200 ms`);
  assert.ok(largeMedian <= smallMedian * 2, `history ${largeMedian.toFixed(2)} ms exceeds 2x small ${smallMedian.toFixed(2)} ms`);
});
