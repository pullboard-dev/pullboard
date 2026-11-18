/** A real file board with a coordinator and builder seats that each have shouts waiting, for the batched inbox marks [C7,#8942]. */
// fixture-subject: addItem
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { privateFixtureFiles } from '../child.js';
import { openKitBoard } from '../board.js';

/** The board, its file, the seats, and the queue ports the worker drains through; `t` closes and removes it all. */
export function marksBoard(t, count) {
  const files = privateFixtureFiles('pullboard-marks-');
  const file = join(files.root, 'board.sqlite');
  const board = openKitBoard(file);
  t.after(() => { store.closeBoard(board); rmSync(files.root, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const seats = Array.from({ length: count }, (_, index) => store.register(board, { lane: 'core', path: `/seat-${index}`, route: 'strong' }));
  for (let i = 0; i < 3; i++) store.shout(board, { from: 'coordinator', to: 'all', text: `shout ${i}` });
  const ports = { enqueue: (agent, mark) => store.enqueueInboxMark(board, agent, mark), flush: () => store.flushInboxMarks(board) };
  return { board, file, seats, ports };
}
