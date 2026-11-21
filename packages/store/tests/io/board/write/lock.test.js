/** Completed board writes over one second add named machine telemetry and a keyed status counter [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../fixtures/cell.js';
import { boardWriteHoldAlarm } from '../../../../src/io/board/write/lock.js';
import { writeFileSync } from 'node:fs';
import { boardWriteCounterRows } from '../../../../src/io/board/write/lock.js';
import { boardWriteLog } from '../../../../src/io/board/write/lock.js';
import { finishBoardWrite } from '../../../../src/io/board/write/lock.js';
import * as store from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { temporaryRepository } from '../../../fixtures/submit.js';

/** Give this test a private machine home and restore the caller's setting. */
function withHome(t, body) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(cellProject(t).repo, 'write-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = saved;
  });
  body();
}

function record(durationMs) {
  return { db: {}, start: 0, acquiredAt: Date.parse('2026-11-20T12:00:00Z'),
    pid: process.pid, command: 'submit', move: 'submit', seat: 'core-9361', item: 12615, complete: false, boardFile: null };
}

test('store.io-board-write-lock.hold-over-one-second: clause 1: a board write held over 1,000 ms records WRITE_HOLD_OVER_1S with move, seat, pid and held ms and a status counter readable by key [C7]', t => withHome(t, () => {
  t.mock.method(performance, 'now', () => 1_001);
  finishBoardWrite(record(1_001), true);
  const rows = readFileSync(boardWriteLog(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const violation = rows.find(row => row.type === 'violation');
  assert.deepEqual({ key: violation.key, move: violation.move, seat: violation.seat, pid: violation.pid, heldMs: violation.heldMs },
    { key: 'WRITE_HOLD_OVER_1S', move: 'submit', seat: 'core-9361', pid: process.pid, heldMs: 1_001 });
  assert.deepEqual(boardWriteCounterRows('WRITE_HOLD_OVER_1S').map(({ key, value }) => ({ key, value })),
    [{ key: 'WRITE_HOLD_OVER_1S', value: 1 }]);
}));

test('store.io-board-write-lock.hold-under-one-second: clause 2: a 999 ms board write records no WRITE_HOLD_OVER_1S violation [C7]', t => withHome(t, () => {
  t.mock.method(performance, 'now', () => 999);
  finishBoardWrite(record(999), true);
  assert.deepEqual(boardWriteCounterRows('WRITE_HOLD_OVER_1S'), []);
}));

test('store.io-board-write-lock.hold-rows-carry-time: clause 1: both the counter row and the violation row of a slow write carry an at epoch-ms field [C7]', t => withHome(t, () => {
  t.mock.method(performance, 'now', () => 1_001);
  const before = Date.now();
  finishBoardWrite(record(1_001), true);
  const rows = readFileSync(boardWriteLog(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const held = rows.filter(row => row.key === 'WRITE_HOLD_OVER_1S');
  assert.deepEqual(held.map(row => row.type).sort(), ['counter', 'violation']);
  for (const row of held) assert.ok(Number.isSafeInteger(row.at) && row.at >= before && row.at <= Date.now(), `${row.type} row has at`);
}));

test('store.io-board-write-lock.hold-alarm-reads-the-window: clause 2: the alarm counts the rows inside the window with the worst move and heldMs, ignoring older rows and rows with no at [C7]', t => withHome(t, () => {
  const now = 1_000_000;
  const row = (at, heldMs, move) => JSON.stringify({ type: 'counter', key: 'WRITE_HOLD_OVER_1S', ...(at === undefined ? {} : { at }), move, heldMs, value: 1 });
  writeFileSync(boardWriteLog(), [row(now - 4_000_000, 9_000, 'old'), row(undefined, 8_000, 'legacy'), row(now - 10, 1_200, 'submit'),
    row(now - 5, 3_400, 'claim'), JSON.stringify({ type: 'violation', key: 'WRITE_HOLD_OVER_1S', at: now - 5, heldMs: 7_000, move: 'v' }), 'not json'].join('\n') + '\n');
  assert.deepEqual(boardWriteHoldAlarm('WRITE_HOLD_OVER_1S', now, 3_600_000), { count: 2, move: 'claim', heldMs: 3_400, truncated: false });
}));

test('store.io-board-write-lock.hold-alarm-bounded-read: clause 3: on a file over 64 KiB the alarm reads only the last 64 KiB and reports truncated when the window reaches past that tail [C7]', t => withHome(t, () => {
  const now = 1_000_000;
  const row = at => JSON.stringify({ type: 'counter', key: 'WRITE_HOLD_OVER_1S', at, move: 'submit', heldMs: 1_500, value: 1 }) + '\n';
  const filler = row(now - 1).repeat(Math.ceil(70 * 1024 / row(now - 1).length));
  writeFileSync(boardWriteLog(), filler);
  const reached = boardWriteHoldAlarm('WRITE_HOLD_OVER_1S', now, 3_600_000);
  assert.equal(reached.truncated, true);
  assert.ok(reached.count > 0 && reached.count * row(now - 1).length <= 64 * 1024, 'only the last 64 KiB was read');
  writeFileSync(boardWriteLog(), row(now - 7_000_000).repeat(Math.ceil(70 * 1024 / row(now - 7_000_000).length)) + row(now - 1));
  assert.deepEqual(boardWriteHoldAlarm('WRITE_HOLD_OVER_1S', now, 3_600_000), { count: 1, move: 'submit', heldMs: 1_500, truncated: false });
}));

/** Sleep the thread, as a table scan over a board of thousands of items does on a loaded machine. */
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('store.io-board-write-lock.merged-slow-step-held: clause 2: a merged move on a board with 250 held items, where a children lookup that scans the item table costs 15 ms, ends its hold within 2.0 s [C7,#12751]', t => {
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, all: process.env.PULLBOARD_BOARD_HOLD_LOG_ALL };
  t.after(() => {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['PULLBOARD_BOARD_HOLD_LOG_ALL', saved.all]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const repo = temporaryRepository(t, 'pullboard-merged-slow-');
  const home = join(repo, 'hold-home');
  mkdirSync(home);
  mkdirSync(join(repo, '.git', 'pullboard'));
  process.env.PULLBOARD_MACHINE_HOME = home;
  process.env.PULLBOARD_BOARD_HOLD_LOG_ALL = '1';
  const board = cellBoard(t, join(repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date() }, { real: true, gitRoot: repo });
  store.board_ensureCoordinator(board, repo);
  const make = title => cellItem(board, { lane: 'core', title, criterion: '1. It works [test]', route: 'mid', brief: 'Files: src/a.js\nTest: proves it', check: 'true' }).item_id;
  const held = Array.from({ length: 250 }, (_, i) => make(`Held ${i}`));
  const mover = make('Lands now');
  for (const id of held) board.db.prepare('UPDATE item SET item_hold_reason=? WHERE item_id=?').run('Waiting for an outside review', id);
  // A children lookup that SQLite answers by scanning every item row costs what it costs on the live board (about 15 ms at this size); one it answers by index costs nothing.
  const prepare = board.db.prepare.bind(board.db);
  board.db.prepare = sql => {
    const statement = prepare(sql);
    if (!/item_parent_id/u.test(sql)) return statement;
    return new Proxy(statement, { get: (target, key) => typeof target[key] === 'function'
      ? (...args) => {
        if (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).some(step => /^SCAN item$/u.test(step.detail))) sleep(15);
        return target[key](...args);
      } : target[key] });
  };
  board.liftSettledHolds = true;
  store.writeBoardCommand(board, 'merged', [mover, { agentId: 'coordinator', commit: 'a'.repeat(40), forced: 'landed by hand', waiveProof: 'test fixture' }], 'coordinator');
  const row = readFileSync(join(home, 'board-holds.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(each => each.move === 'merged').at(-1);
  t.diagnostic(`merged hold heldMs=${row.heldMs} step=${row.step} stepMs=${row.stepMs}`);
  assert.ok(row.heldMs < 2_000, `the merged move held the board ${row.heldMs} ms, slowest step ${row.step}`);
});

test('store.io-board-write-lock.parent-index-build-time: clause 2: item_parent_status built on 12,750 items of about 600 characters of text answers the children lookup from the index alone, and its build time is reported as a diagnostic [C7,#12751]', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_parent_id INTEGER, item_status TEXT, item_merged_commit TEXT, item_brief TEXT)');
  const insert = db.prepare('INSERT INTO item (item_parent_id, item_status, item_merged_commit, item_brief) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 12_750; i += 1) insert.run(i % 6 === 0 ? i / 6 + 1 : null, 'verified', i % 2 ? 'a'.repeat(40) : null, 'x'.repeat(600));
  db.exec('COMMIT');
  const started = performance.now();
  db.exec('CREATE INDEX IF NOT EXISTS item_parent_status ON item (item_parent_id, item_status, item_merged_commit)');
  const ms = performance.now() - started;
  t.diagnostic(`item_parent_status build ms=${ms.toFixed(1)} on 12750 items`);
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT item_status,item_merged_commit FROM item WHERE item_parent_id=?').all(1);
  assert.ok(plan.some(step => /USING COVERING INDEX item_parent_status/u.test(step.detail)), 'the children lookup is answered from the index alone');
});
