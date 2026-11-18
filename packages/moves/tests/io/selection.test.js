/** next's selection warms from this seat's three latest built items with one bounded read, never the whole item list [N2,C7,#10692]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { fixture } from '../fixtures/next.js';
import { nextSelection } from '../../index.js';

/** Seed closed built items as a long-running board holds them: filed open with a builder, withdrawn by the coordinator, each keeping its own last update. */
function seedBuilt(box) {
  const insert = box.board.db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_route, item_built_by, item_files,
    item_created_by, item_created_at, item_updated_at) VALUES ('web', ?, 'The real fixture succeeds.', 'mid', ?, ?, 'coordinator', '2026-10-01T00:00:00.000Z', ?)`);
  const row = (title, builder, file, updated) => Number(insert.run(title, builder, file, updated).lastInsertRowid);
  // 50 closed items built by another seat, many updated after this seat's own items.
  for (let n = 0; n < 50; n++) row(`Closed by another seat ${n}`, box.seats.builder.id, `web/other-${n}.js`, `2026-10-2${n % 5}T0${n % 10}:00:00.000Z`);
  const older = row('Closed by this seat, older', box.seats.actor.id, 'web/older.js', '2026-10-20T00:00:00.000Z');
  const recent = [['web/first.js', '2026-10-22T00:00:00.000Z'], ['web/second.js', '2026-10-23T00:00:00.000Z'], ['web/third.js', '2026-10-24T00:00:00.000Z']]
    .map(([file, updated], n) => ({ id: row(`Closed by this seat, recent ${n}`, box.seats.actor.id, file, updated), file }));
  const stamp = box.board.db.prepare('UPDATE item SET item_updated_at = ? WHERE item_id = ?');
  for (const { item_id: id, item_updated_at: updated } of box.board.db.prepare("SELECT item_id, item_updated_at FROM item WHERE item_title LIKE 'Closed by %'").all()) {
    store.withdraw(box.board, id, { agentId: 'coordinator', reason: 'closed fixture item' });
    stamp.run(updated, id);
  }
  return { older, recent: recent.reverse() };
}

/** Record every statement prepared on the board while `work` runs: its SQL, its arguments and the rows it returned. */
function recorded(board, work) {
  const db = board.db, prepare = db.prepare.bind(db), reads = [];
  db.prepare = sql => {
    const statement = prepare(sql);
    return new Proxy(statement, { get: (target, name) => name === 'all'
      ? (...args) => { const rows = target.all(...args); reads.push({ sql, args, rows }); return rows; }
      : typeof target[name] === 'function' ? target[name].bind(target) : target[name] });
  };
  try { return { value: work(), reads }; } finally { delete db.prepare; }
}

test('moves.selection.warm-files-bounded: clause 1: with 50 closed items by other seats and 3 recent built items by this seat, the warm files nextSelection.pick uses are exactly those 3 items files, read without listing all items [N2,C7,#10692]', t => {
  const box = fixture(t);
  const open = box.add('Open work for the pick');
  const { older, recent } = seedBuilt(box);
  const { value, reads } = recorded(box.board, () => nextSelection.pick(box.ctx, box.board, { defaultLoop: true, observeIdle: true, omitIds: [] }, box.ports));
  assert.equal(value.item?.item_id, open, 'the pick still selects the open item');
  const warm = reads.filter(read => /\bitem_built_by = \?/u.test(read.sql) && read.args[0] === box.seats.actor.id);
  assert.equal(warm.length, 1, 'one bounded read of this seat\'s built items');
  const [read] = warm;
  assert.match(read.sql, /LIMIT 3/u, 'the read is bounded at three items');
  assert.deepEqual(read.rows.map(entry => entry.item_id), recent.map(entry => entry.id), 'the three latest items, newest first');
  assert.ok(!read.rows.some(entry => entry.item_id === older), 'the older fourth item is not warm');
  assert.deepEqual(read.rows.map(entry => entry.item_files), recent.map(entry => entry.file), 'the warm files are exactly those three items\' files');
  // The board holds 50 + 4 built items besides the open one; the warm read returned three rows, not the list.
  assert.equal(read.rows.length, 3);
});
