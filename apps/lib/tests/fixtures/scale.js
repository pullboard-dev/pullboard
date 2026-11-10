import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../../cli/tests/fixtures/board.js';

/** Register a seat on a fixture board in process, so scaler tests share one place that does it [B26,C7]. */
export function fixtureRegister(board, seat) {
  return store.register(board, seat);
}

/** Add an item to a fixture board in process, so scaler tests share one place that does it [B26,C7]. */
export function fixtureAddItem(board, item) {
  return store.addItem(board, item);
}

/** Open a fixture board with a coordinator and `count` open web items, so scaler tests share one setup [B26,C7]. */
export function openGatedWebBoard(t, at, count) {
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  fixtureRegister(board, { lane: 'coordinator', path: '/fixture/main' });
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push(fixtureAddItem(board, { by: 'coordinator', lane: 'web', title: `gated ${index}`, brief: `Files: web/gated${index}.js` }));
  return { board, ids };
}
