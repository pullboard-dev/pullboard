import * as store from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';

/** Open a fixture board with a coordinator and `count` open web items, so scaler tests share one setup [B26,C7]. */
export function openGatedWebBoard(t, at, count) {
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  store.register(board, { lane: 'coordinator', path: '/fixture/main' });
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push(store.addItem(board, { by: 'coordinator', lane: 'web', title: `gated ${index}`, brief: `Files: web/gated${index}.js` }));
  return { board, ids };
}
