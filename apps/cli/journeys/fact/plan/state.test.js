/** The view state gets recent events and last moves through indexed queries [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { projectState } from '../../../src/io/view.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
const EVENTS = 45_000;
after(e2e.cleanup);

test('the view state reads recent events by index [C7]', () => {
  const box = e2e.project();
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const insert = board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, NULL, ?)');
    const base = Math.max(...store.events(board).map((event) => Date.parse(event.event_at))) + 1000;
    board.db.exec('BEGIN');
    try {
      for (let n = 0; n < EVENTS; n += 1) {
        insert.run(new Date(base + n * 1000).toISOString(), n % 2 ? 'web-1' : 'coordinator', 'shout', '{}');
      }
      board.db.exec('COMMIT');
    } catch (error) {
      board.db.exec('ROLLBACK');
      throw error;
    }

    const originalLog = store.events(board);
    const expectedMoves = new Map(originalLog.map((event) => [event.event_by, event.event_at]));
    const expectedAgents = store.listAgents(board).map((agent) => [agent.agent_id, expectedMoves.get(agent.agent_id) ?? null]);
    const statements = [];
    const db = new Proxy(board.db, {
      get(target, key) {
        if (key === 'prepare') return (sql, ...params) => {
          if (/\b(?:FROM|JOIN)\s+event\b/iu.test(sql)) statements.push(sql);
          return target.prepare(sql, ...params);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const observedBoard = new Proxy(board, {
      get(target, key) {
        if (key === 'db') return db;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const state = projectState(box.repo, { board: observedBoard });
    assert.deepEqual(state.events, originalLog.slice(-80).reverse(), 'the view keeps the same newest-first activity');
    assert.deepEqual(state.agents.map((agent) => [agent.agent_id, agent.lastMoveAt]), expectedAgents,
      'the view keeps each agent’s most recent event time');
    assert.ok(statements.some((sql) => /SELECT\s+agent_id,\s*\(SELECT\s+MAX\(event_at\)/iu.test(sql)),
      'the state asks the indexed per-agent last-move query');
    assert.ok(statements.some((sql) => /ORDER BY event_id DESC LIMIT \?/iu.test(sql)),
      'the state asks for only the bounded newest event range');

    for (const sql of statements) {
      const parameters = (sql.match(/\?/gu) ?? []).map(() => 80);
      const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => row.detail);
      assert.doesNotMatch(plan.join('\n'), /^(?:SCAN event\b|SEARCH event USING AUTOMATIC)/mu,
        `the view state must not scan the event table for: ${sql}`);
    }
  } finally {
    store.closeBoard(board);
  }
});
