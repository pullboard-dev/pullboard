/** Completed board writes over one second add named machine telemetry and a keyed status counter [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../fixtures/cell.js';
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
