/** Shared real board and Git setup for ordering regressions [N2,B13,H16]. */
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { submitFixture } from '../board/submit.js';
import { createE2eHelpers } from '../e2e.js';

export const HOUR = 60 * 60 * 1000;
export const MID_ITEM_DETAILS = {
  criterion: 'the item can be built and checked from its brief',
  check: 'true',
  brief: 'Files: src/board.js\nTest: verify the candidate follows the release roadmap',
};
/** Build the minimal frozen bar required to submit a fixture item. */
export const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** Open a real SQLite board and register a coordinator plus strong builder and reviewer agents. */
export function boardFixture(engine = null) {
  const board = openBoard(':memory:');
  if (engine !== null) board.executionEngineVersion = engine;
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'review', path: '/reviewer', route: 'strong' });
  return { board, builder, reviewer };
}

/** Add one open strong-route core item, ready for next to offer. */
export function readyItem(board, title, extra = {}) {
  // fixture-subject: addItem
  return store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong', ...extra });
}

/** Add and submit an item through the board's normal claim and submit moves. */
export function submitted(board, builder, title, route, number) {
  const id = store.addItem(board, {
    by: 'coordinator', lane: 'core', title, route,
    ...(route === 'mid' ? MID_ITEM_DETAILS : {}),
  });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const hash = String(number).repeat(40);
  submitFixture(board, id, { agentId: builder, commit: hash, tree: hash });
  return id;
}

/** A private real Git repository and SQLite queue; lifecycle records below are not gate executions. */
export function lineOrderFixture(t, engine = null) {
  const helpers = createE2eHelpers();
  const box = helpers.sandbox();
  const root = join(box.dir, 'line-order');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { core: { owns: ['src/'], specs: [] } } }));
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-qm', 'test: seed the private line-order repository');
  const board = openBoard(join(root, 'board.sqlite'), undefined, { gitRoot: root });
  if (engine !== null) board.executionEngineVersion = engine;
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'core', path: join(root, 'builder'), route: 'strong', parent: 'builder-P', session: 'builder-child' });
  const reviewer = store.register(board, { lane: 'review', path: join(root, 'reviewer'), route: 'strong', parent: 'reviewer-R', session: 'reviewer-child' });
  t.after(() => { store.closeBoard(board); helpers.cleanup(); });
  /** Switch only the recorded ordering control; other line controls remain off. */
  function order(value) {
    store.setLineSetting(board, { agentId: 'coordinator', key: 'order', value, reason: 'private queue policy control', window: { windowMinutes: 60, activeReviewers: 3 } });
  }
  return { board, root, builder, reviewer, order };
}

/** An open strong-route core item whose brief names these files, so file contention can see it. */
export function filesItem(board, title, files) {
  // fixture-subject: addItem
  return store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong', brief: `Files: ${files.join(', ')}` });
}

/** Register one more strong core builder seat. */
export function builderSeat(board, name) {
  return store.register(board, { lane: 'core', path: `/${name}`, route: 'strong' });
}

/** Claim an item for a seat, so its files are in flight. */
export function takeItem(board, id, agentId) {
  store.claim(board, id, { agentId, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
}

/** File one strong core item per spec, in order, and return their ids; `after` lists earlier specs' ids by index. */
export function coreItems(board, specs) {
  const ids = [];
  for (const spec of specs) ids.push(store.addItem(board, { by: 'coordinator', lane: 'core', route: 'strong', title: spec.title,
    ...(spec.after === undefined ? {} : { after: spec.after.map(index => ids[index]) }) }));
  return ids;
}
