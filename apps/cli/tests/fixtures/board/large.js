/** A large board for speed budgets: the shared e2e repo and joined web seat, seeded to production scale [C7]. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createE2eHelpers } from '../e2e.js';
import { ensureJobTables } from '../../../../../packages/store/index.js';
import { LEDGER_SCHEMA_SQL } from '../../../../../packages/store/index.js';

/** The recorded production scale: items, events, shouts and departed seats. */
export const LARGE_BOARD = { items: 2_500, events: 112_500, shouts: 58_000, seats: 800 };

/**
 * The live board on 20 Nov 2026 at 15:50 CT, scaled to 1:4 for the speed budgets. LARGE_BOARD seeds only items, events,
 * shouts and seats; the slow paths in `next` grow with job history, test results and board_meta, so a budget that runs
 * on this scale says something about the live board. Live counts: 12,567 items, 677,810 events (181,874 by the
 * coordinator seat), 111,864 shouts, 10,681 agents, 877,494 job_steps, 745,346 test_results, 31,056 undelivered
 * finished test-run jobs and 815,588 board_meta rows. Each scaled count below is the live count divided by four.
 */
export const HISTORY_BOARD = {
  ratio: '1:4',
  items: 3_142,
  events: 169_453,
  bigSeatEvents: 45_469,
  shouts: 27_966,
  seats: 2_670,
  jobSteps: 219_374,
  testResults: 186_337,
  testRuns: 7_764,
  boardMeta: 203_897,
};

/**
 * Fill a board file to `scale`: departed seats, items, an event log, and shouts with every tenth an ask, some answered.
 * Why direct inserts: filing 2,500 items and 58,000 shouts through the CLI would take longer than the gate allows.
 *
 * @param {string} file The board.sqlite path.
 * @param {typeof LARGE_BOARD | typeof HISTORY_BOARD} [scale] History fields (testRuns, jobSteps, testResults, boardMeta, bigSeatEvents) are seeded only when present.
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
    event.run(at(n), n < (scale.bigSeatEvents ?? 0) ? 'coordinator' : `web-${100 + (n % scale.seats)}`, kinds[n % kinds.length], n % 10 ? first + (n % scale.items) : null, '{}');
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
  if (scale.testRuns !== undefined) seedHistory(db, scale);
  db.exec('COMMIT');
  db.close();
}

/**
 * Seed the job, step, test-result and board_meta history inside the caller's transaction, in the shape the jobs and
 * the ledger write: each finished test-run job (step done, so undelivered) has a queued, running and result step; the
 * rest of the step budget sits on delivered gate jobs.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {typeof HISTORY_BOARD} scale
 */
function seedHistory(db, scale) {
  ensureJobTables(db);
  db.exec(LEDGER_SCHEMA_SQL);
  const stamp = (n) => Date.UTC(2026, 9, 1) + n * 1000;
  const job = db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?)');
  const step = db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, 0, ?, ?)');
  let steps = 0;
  for (let n = 0; n < scale.testRuns; n += 1) {
    const id = `seed-run-${n}`;
    job.run(id, 'test-run', null, 'done', stamp(n), stamp(n + 1));
    step.run(id, 'queued', JSON.stringify({ agent: `web-${100 + (n % scale.seats)}`, files: ['test/seed.test.js'], affected: false, compareMain: false }), stamp(n));
    step.run(id, 'running', '{"pid":1}', stamp(n));
    step.run(id, 'result', JSON.stringify({ green: true, runner: 'seed', seconds: 1, counts: { passed: 1, failed: 0, skipped: 0 } }), stamp(n + 1));
    steps += 3;
  }
  for (let n = 0; steps < scale.jobSteps; n += 1) {
    const id = `seed-gate-${n}`;
    job.run(id, 'gate', null, 'delivered', stamp(n), stamp(n + 1));
    for (let k = 0; k < 4 && steps < scale.jobSteps; k += 1, steps += 1) step.run(id, `note:seed-${k}`, '{}', stamp(n));
  }
  const result = db.prepare(`INSERT INTO test_result (test_result_file, test_result_input_key, test_result_command, test_result_context,
    test_result_status, test_result_receipt, test_result_origin, test_result_commit, test_result_at) VALUES (?, ?, 'node test', 'seed', ?, ?, 'runner', ?, ?)`);
  for (let n = 0; n < scale.testResults; n += 1) {
    result.run(`tests/seed-${n % 3_000}.test.js`, `key-${n % 2_000}`, n % 20 ? 'pass' : 'fail', `receipt-${n}`, `c${n % 400}`, stamp(n));
  }
  const meta = db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)');
  for (let n = 0; n < scale.boardMeta; n += 1) meta.run(`local:seed:${n}`, '{}');
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
