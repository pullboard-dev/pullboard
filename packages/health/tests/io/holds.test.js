/** The health line names the live board's holds over 200 ms and no other board's [C7,#3190]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slowHoldLines } from '../../index.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const LIVE = '/boards/live/board.sqlite';
const row = (boardFile, command, seat, heldMs, minutesAgo = 5) => ({ version: 1, at: new Date(NOW - minutesAgo * 60_000).toISOString(), command, seat, heldMs, boardFile });

test('clause 1: the board health line names the command, seat and held time of a live-board hold over 200 ms from the last hour [C7,#3190]', () => {
  const lines = slowHoldLines([row(LIVE, 'submit', 'core-9', 450), row(LIVE, 'claim', 'core-1', 120), row(LIVE, 'old', 'core-2', 800, 90)], LIVE, { now: NOW });
  assert.equal(lines.length, 1, 'a fast hold and an hour-old hold are not named');
  assert.match(lines[0], /submit by core-9 held the board 450 ms/u);
});

test('clause 2: hold rows from other board files are not named [C7,#3190]', () => {
  const lines = slowHoldLines([row('/tmp/test/board.sqlite', 'verify', 'test-seat', 900), row(null, 'verify', 'test-seat', 900), row(LIVE, 'submit', 'core-9', 450)], LIVE, { now: NOW });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('test-seat'));
});
