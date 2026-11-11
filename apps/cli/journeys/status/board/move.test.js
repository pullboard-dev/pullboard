/** A board hold receipt names the move and the slowest step inside it, and status lists the longest holds of the last hour [C7,P4]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { closeCellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: a hold row carries the move and the slowest named step with its ms [C7,P4]', t => {
  const box = cellProject(t);
  closeCellBoard(openCellBoard(box.boardFile));
  box.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'move-observations');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const source = `
    import { closeBoard, atomic } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
    import { measureBoardWritePhase } from ${JSON.stringify(new URL('../../../../../packages/store/src/io/board/write/lock.js', import.meta.url).href)};
    const board = openBoard(process.argv[1], undefined, { writeContext: { command: 'fixture-move', seat: 'web-1', item: 7 } });
    const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    try {
      atomic(board, () => measureBoardWritePhase(board.db, 'native-move', () => {
        measureBoardWritePhase(board.db, 'fast-step', () => wait(20));
        measureBoardWritePhase(board.db, 'slow-step', () => wait(1_200));
      }, 'recordLandingBatch'));
    } finally { closeBoard(board); }
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  for (const log of ['board-holds.jsonl', 'board-writes.jsonl']) {
    const rows = readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, log), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.command === 'fixture-move');
    assert.equal(rows.length, 1, `${log} holds one row for the move`);
    assert.equal(rows[0].move, 'recordLandingBatch', `${log} names the move`);
    assert.equal(rows[0].phase, 'native-move');
    assert.equal(rows[0].step, 'slow-step', `${log} names the slowest step inside the move`);
    assert.ok(rows[0].stepMs >= 1_200 && rows[0].stepMs <= rows[0].heldMs);
  }
});

test('clause 1: a write with no named move body still carries a move on every hold row [C7,P4]', t => {
  const box = cellProject(t);
  closeCellBoard(openCellBoard(box.boardFile));
  box.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'unnamed-observations');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const source = `
    import { closeBoard, atomic } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
    const board = openBoard(process.argv[1], undefined, { writeContext: { command: 'fixture-bare', seat: 'web-1', item: 7 } });
    try { atomic(board, () => {}); } finally { closeBoard(board); }
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context);
  for (const log of ['board-writes.jsonl']) {
    const rows = readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, log), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.command === 'fixture-bare');
    assert.equal(rows.length, 1, `${log} holds one row`);
    assert.equal(rows[0].move, 'fixture-bare', `${log} names a move, never null`);
  }
});

test('clause 2: status lists the five longest holds of the last hour with at, move, step and heldMs [C7,P4]', () => {
  const box = helpers.project('true');
  box.env.PULLBOARD_MACHINE_HOME = join(box.dir, 'status-observations');
  const now = Date.now();
  const row = (ageMs, heldMs, move) => JSON.stringify({ version: 1, at: new Date(now - ageMs).toISOString(), command: 'api', seat: 'web-1', item: null,
    heldMs, outcome: 'committed', phase: 'native-move', phaseMs: heldMs, move, step: 'replay', stepMs: heldMs - 100 }) + '\n';
  const log = join(box.env.PULLBOARD_MACHINE_HOME, 'board-holds.jsonl');
  const lines = [[10_000, 1_500, 'm1'], [20_000, 9_000, 'm2'], [30_000, 3_000, 'm3'], [40_000, 2_000, 'm4'], [50_000, 4_000, 'm5'],
    [60_000, 2_500, 'm6'], [7_200_000, 60_000, 'too-old']];
  runFixtureChild(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(box.env.PULLBOARD_MACHINE_HOME)}, { recursive: true })`], { env: box.env });
  for (const [age, held, move] of lines) appendFileSync(log, row(age, held, move));
  const result = box.run(box.repo, 'status', '--json');
  assert.equal(result.code, 0, result.err);
  const holds = JSON.parse(result.out).longestHolds;
  assert.deepEqual(holds.map(hold => hold.move), ['m2', 'm5', 'm3', 'm6', 'm4'], 'five longest of the last hour, longest first, the 2-hour-old hold left out');
  assert.deepEqual(Object.keys(holds[0]).sort(), ['at', 'heldMs', 'move', 'step', 'stepMs']);
  assert.equal(holds[0].heldMs, 9_000);
  const shown = box.run(box.repo, 'status');
  assert.match(shown.out, /board hold \S+: 9000 ms in m2, slowest step replay 8900 ms/u);
});
