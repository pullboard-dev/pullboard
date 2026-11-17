/** @pullboard-test-input source-cell packages/board */
/** A recorded write hold names the caller whose body held the lock, never this module's own line [#2282,#6825]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { appendFact } from '../../../../../../store/index.js';
import { writeOrigin } from '../../../../../../store/index.js';
import { cellBoard } from '../../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../../store/tests/fixtures/cell.js';

test('board.origin.and-hold-row-names-the-calling: clause 1 and clause 2: a hold row names the calling file and line, not the event log that runs the transaction [C7,#2282,#6825]', t => {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = saved;
  });
  const project = cellProject(t);
  const home = join(project.repo, 'hold-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const item = cellItem(board, { lane: 'web', title: 'Hold origin fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  appendFact(board, item, { agentId: seat.id, kind: 'note', text: 'observation' });
  const rows = readFileSync(join(home, 'board-writes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const phases = rows.map(row => row.phase).filter(phase => phase.startsWith('work'));
  assert.ok(phases.length > 0, 'a work phase was recorded');
  for (const phase of phases) assert.doesNotMatch(phase, /^work:log\.js:/u, `${phase} names the event log itself`);
});

test('board.origin.and-stack-whose-checkout-folder-has: clause 1 and clause 2: a stack whose checkout folder has a space still skips the event log and names the caller [C7,#8496]', () => {
  const own = '/srv/dev/Open Source/pullboard/packages/store/src/io/board/event/log.js';
  const caller = '/srv/dev/Open Source/pullboard/apps/cli/src/io/move.js';
  const stack = `Error\n    at transaction (${pathToFileURL(own).href}:115:3)\n    at move (${pathToFileURL(caller).href}:9:1)`;
  const origin = writeOrigin(stack, own);
  assert.equal(origin[1], caller, 'the caller, not the event log, holds the write');
  assert.equal(origin[2], '9');
});
