/** A large board for speed budgets: the shared e2e repo and joined web seat, seeded to production scale [C7]. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';

/** The recorded production scale: items, events, shouts and departed seats. */
export const LARGE_BOARD = { items: 2_500, events: 112_500, shouts: 58_000, seats: 800 };

/**
 * Fill a board file to `scale`: departed seats, items, an event log, and shouts with every tenth an ask, some answered.
 * Why direct inserts: filing 2,500 items and 58,000 shouts through the CLI would take longer than the gate allows.
 *
 * @param {string} file The board.sqlite path.
 * @param {typeof LARGE_BOARD} [scale]
 */
export function seedLargeBoard(file, scale = LARGE_BOARD) {
  const db = new DatabaseSync(file);
  const at = (n) => new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString();
  db.exec('BEGIN');
  const seat = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < scale.seats; n += 1) seat.run(`web-${n + 100}`, 'web', `/gone/web-${n + 100}`, at(n));
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_created_by, item_created_at, item_updated_at)
    VALUES ('web', ?, 'The feature works.', 'coordinator', ?, ?)`);
  for (let n = 0; n < scale.items; n += 1) item.run(`Seeded item ${n}`, at(n), at(n));
  const first = Number(db.prepare('SELECT min(item_id) AS id FROM item WHERE item_title LIKE ?').get('Seeded item %').id);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const kinds = ['add', 'claim', 'renew', 'shout', 'edit'];
  for (let n = 0; n < scale.events; n += 1) {
    event.run(at(n), `web-${100 + (n % scale.seats)}`, kinds[n % kinds.length], n % 10 ? first + (n % scale.items) : null, '{}');
  }
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at, shout_decision, shout_answers) VALUES (?, ?, ?, ?, ?, ?)');
  const base = Number(db.prepare('SELECT coalesce(max(shout_id), 0) AS id FROM shout').get().id);
  for (let n = 0; n < scale.shouts; n += 1) {
    const asks = n % 10 === 0;
    const to = asks ? (n % 20 === 0 ? 'coordinator' : 'person') : 'all';
    // Every other coordinator ask is answered two shouts later.
    const answers = n % 40 === 2 ? base + n - 1 : null;
    shout.run(`web-${100 + (n % scale.seats)}`, to, `shout ${n}`, at(n), asks ? 1 : 0, answers);
  }
  db.exec('COMMIT');
  db.close();
}

/**
 * The shared e2e project (a repo with web and api lanes and a joined web seat) on a board seeded to `scale`.
 * Its sandbox is removed after the test; a function passed to `beforeCleanup` runs first, so a test can stop
 * processes it started there.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ scale?: typeof LARGE_BOARD }} [options]
 */
export function largeBoard(t, { scale = LARGE_BOARD } = {}) {
  const helpers = createE2eHelpers();
  const first = [];
  t.after(() => { try { for (const stop of first) stop(); } finally { helpers.cleanup(); } });
  const box = helpers.project('true');
  const board = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  seedLargeBoard(board, scale);
  return { ...box, board, beforeCleanup: (stop) => { first.push(stop); } };
}
