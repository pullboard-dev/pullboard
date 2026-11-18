/** Board hold percentiles read the every-write log when it exists and mark the holds-log fallback as over-a-second only [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../fixtures/cell.js';
import { boardHoldPercentiles } from '../../../../src/io/board/hold/log.js';

/** Run a body with the machine home pointed at a fresh directory, then restore it. */
function withHome(t, body) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const savedAll = process.env.PULLBOARD_BOARD_HOLD_LOG_ALL;
  const home = join(cellProject(t).repo, 'percentile-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  delete process.env.PULLBOARD_BOARD_HOLD_LOG_ALL;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    if (savedAll !== undefined) process.env.PULLBOARD_BOARD_HOLD_LOG_ALL = savedAll;
  });
  body(home);
}
const NOW = Date.parse('2026-11-18T12:00:00Z');
const rows = (heldList, boardFile) => heldList.map((heldMs, i) => JSON.stringify({ version: 1, at: new Date(NOW - 60_000 - i).toISOString(), command: 'c', seat: 's', heldMs, boardFile })).join('\n') + '\n';

test('store.hold.percentiles-every-write: clause 1: the median counts every write in board-writes.jsonl and names the log it read [C7]', t => withHome(t, home => {
  writeFileSync(join(home, 'board-writes.jsonl'), rows([10, 20, 30, 40, 5000]));
  writeFileSync(join(home, 'board-holds.jsonl'), rows([5000, 6000]));
  const result = boardHoldPercentiles({ until: NOW });
  assert.equal(result.count, 5);
  assert.equal(result.medianMs, 30);
  assert.equal(result.source, 'every-write');
  assert.equal(result.log, join(home, 'board-writes.jsonl'));
  assert.equal(result.overSecondOnly, false);
  writeFileSync(join(home, 'board-writes.jsonl'), rows([10, 20], '/a/board.db') + rows([900, 900], '/b/board.db'));
  assert.equal(boardHoldPercentiles({ until: NOW, boardFile: '/a/board.db' }).count, 2);
}));

test('store.hold.percentiles-fallback-marked: clause 2: with no every-write log it reads board-holds.jsonl and marks the result over-a-second only [C7]', t => withHome(t, home => {
  writeFileSync(join(home, 'board-holds.jsonl'), rows([1300, 1500, 2500]));
  const result = boardHoldPercentiles({ until: NOW });
  assert.equal(result.source, 'over-a-second');
  assert.equal(result.log, join(home, 'board-holds.jsonl'));
  assert.equal(result.overSecondOnly, true);
  assert.equal(result.medianMs, 1500);
}));
