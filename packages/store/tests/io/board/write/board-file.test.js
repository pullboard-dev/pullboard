/** Every write-log and hold-log row names the board file it wrote, so live latency is told apart from test boards [C7,#3190]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendFact } from '../../../../index.js';
import { HOLD_LOG_ALL_ENV } from '../../../../src/io/board/hold/log.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';

/** Write one fact on a real board file with every hold logged, then read both machine logs back. */
function writeAndRead(t) {
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, all: process.env[HOLD_LOG_ALL_ENV] };
  t.after(() => {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], [HOLD_LOG_ALL_ENV, saved.all]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const project = cellProject(t, { real: true });
  const home = join(project.repo, 'hold-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  process.env[HOLD_LOG_ALL_ENV] = '1';
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const item = cellItem(board, { lane: 'web', title: 'Board file fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  appendFact(board, item, { agentId: seat.id, kind: 'note', text: 'observation' });
  const read = name => readFileSync(join(home, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { file: realpathSync(project.boardFile), writes: read('board-writes.jsonl'), holds: read('board-holds.jsonl') };
}

test('clause 1: every board-writes.jsonl row carries the absolute path of the board file [C7,#3190]', t => {
  const { file, writes } = writeAndRead(t);
  assert.ok(writes.length > 0, 'writes were recorded');
  for (const row of writes) assert.equal(realpathSync(row.boardFile), file, `${row.command} row names the board file`);
});

test('clause 2: a board-holds.jsonl row carries the absolute path of the board file [C7,#3190]', t => {
  const { file, holds } = writeAndRead(t);
  assert.ok(holds.length > 0, 'holds were recorded');
  for (const row of holds) assert.equal(realpathSync(row.boardFile), file, `${row.command} row names the board file`);
});
