/** Completed board writes over one second add named machine telemetry and a keyed status counter [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../fixtures/cell.js';
import { boardWriteHoldAlarm } from '../../../../src/io/board/write/lock.js';
import { writeFileSync } from 'node:fs';
import { boardWriteCounterRows } from '../../../../src/io/board/write/lock.js';
import { boardWriteLog } from '../../../../src/io/board/write/lock.js';
import { finishBoardWrite } from '../../../../src/io/board/write/lock.js';

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
