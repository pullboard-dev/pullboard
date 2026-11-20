/** @pullboard-test-input source-cell packages/store */
/** expediteItem writes one expedite event, and expeditedItems drops an item once a gate verdict is recorded after it [C7,#12295]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expediteItem } from '../../../src/io/board/expedite.js';
import { expeditedItems } from '../../../src/io/board/expedite.js';
import { logEvent } from '../../../src/io/board/event/log.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';

const events = board => board.db.prepare('SELECT event_by, event_kind, item_id, event_detail FROM event ORDER BY event_id').all();
const item = (board, title) => cellItem(board, { lane: 'core', title, criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;

test('store.expedite.one-event: clause 1: expediteItem appends exactly one expedite event whose detail is { reason } and writes nothing else, and an unknown item is refused with no event [C7,#12295]', t => {
  const board = cellBoard(t, ':memory:', { now: () => new Date() });
  const id = item(board, 'expedited item');
  const before = events(board);
  expediteItem(board, id, { agentId: 'coordinator', reason: 'blocks the lander' });
  const after = events(board);
  assert.equal(after.length, before.length + 1, 'exactly one event is appended');
  const written = after.at(-1);
  assert.equal(written.event_kind, 'expedite');
  assert.equal(written.item_id, id);
  assert.equal(written.event_by, 'coordinator');
  assert.deepEqual(JSON.parse(written.event_detail), { reason: 'blocks the lander' });
  assert.throws(() => expediteItem(board, id + 999, { agentId: 'coordinator', reason: 'x' }), error => error.code === 'NO_ITEM');
  assert.equal(events(board).length, after.length, 'a refused expedite writes no event');
});

test('store.expedite.set-clears-on-settle: clause 2: expeditedItems lists the items with an expedite event and no gate verdict recorded after it, and an item drops out once a gate verdict for it is recorded [C7,#12295]', t => {
  const board = cellBoard(t, ':memory:', { now: () => new Date() });
  const [a, b] = [item(board, 'first'), item(board, 'second')];
  assert.deepEqual(expeditedItems(board), []);
  logEvent(board, 'runner', 'run_applied', a, { job: `gate:${a}:abc:1`, attempt: 1, outcome: 'green', state: 'done' });
  expediteItem(board, a, { agentId: 'coordinator', reason: 'again' });
  expediteItem(board, b, { agentId: 'coordinator', reason: 'now' });
  assert.deepEqual(expeditedItems(board), [a, b], 'a verdict recorded before the expedite does not clear it');
  logEvent(board, 'runner', 'run_applied', a, { job: `shard:${a}:abc:1`, attempt: 1, outcome: 'green', state: 'done' });
  assert.deepEqual(expeditedItems(board), [a, b], 'a verdict from a job that is not a gate does not clear it');
  logEvent(board, 'runner', 'run_applied', a, { job: `gate:${a}:def:2`, attempt: 1, outcome: 'red', state: 'done' });
  assert.deepEqual(expeditedItems(board), [b], 'a gate verdict recorded after the expedite drops the item');
});
