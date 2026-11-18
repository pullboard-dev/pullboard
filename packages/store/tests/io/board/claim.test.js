/** @pullboard-test-input source-cell store */
// fixture-subject: claimRows over a real board, with item-keyed board_meta rows for a check baseline, a bar revision, and a sign-off
/** A prepared claim reads its item's board_meta rows by exact key, with no scan of board_meta, and the same rows as the old LIKE read [C7,#10858,#5329]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimRows } from '../../../src/io/board/claim.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';

/** The read claimRows made before: every board_meta key ending in :<id> or _<id>, with the two board-wide keys. */
function legacyMeta(board, id) {
  return board.db.prepare(`SELECT meta_key,meta_value FROM board_meta WHERE meta_key IN ('row_decisions','bar_ready_setting')
    OR meta_key LIKE '%:' || ? OR meta_key LIKE '%\\_' || ? ESCAPE '\\' ORDER BY meta_key`).all(String(id), String(id)).map(row => ({ ...row }));
}

/** A board with an item, its item-keyed meta rows, and the same families for item 112 and unrelated rows. */
function setup(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const item = cellItem(board, { lane: 'web', title: 'Meta fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' });
  const put = (key, value = '{}') => board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(key, value);
  const id = item.item_id;
  const baseline = `item_check_baseline_${id}`;
  for (const target of [id, 12, 112]) {
    put(`item_check_baseline_${target}`, '{"red":true}');
    put(`bar_revision:${target}`, '{"revision":3}');
    put(`bar_sign:${target}`, '{"by":"coordinator"}');
  }
  put('row_decisions', '{"G1":"met"}');
  put('bar_ready_setting', '{"since":"2026-11-18"}');
  put('local:proof-stats:v2:item:99', '{"cache":1}');
  return { board, id, baseline };
}

test('store.io-board-claim.claimrows-reads-same-rows-as-main: clause 1: claimRows returns the same item-keyed rows as the old LIKE read for an item with a check baseline, a bar revision, and a sign-off, and item 12 beside item 112 [C7,#10858]', t => {
  const { board, id, baseline } = setup(t);
  const meta = JSON.parse(claimRows(board, id)).meta;
  const keys = meta.map(row => row.meta_key);
  for (const key of [baseline, `bar_revision:${id}`, `bar_sign:${id}`, 'row_decisions', 'bar_ready_setting']) assert.ok(keys.includes(key), `${key} is read`);
  assert.deepEqual(meta, legacyMeta(board, id), 'the rows are the old read\'s rows');
  const twelve = JSON.parse(claimRows(board, 12)).meta.map(row => row.meta_key);
  assert.deepEqual(twelve, ['bar_ready_setting', 'bar_revision:12', 'bar_sign:12', 'item_check_baseline_12', 'row_decisions'], 'item 12 reads its own rows only');
  assert.ok(!twelve.some(key => key.endsWith('112')), 'item 112 rows do not leak into item 12');
});

test('store.io-board-claim.claimrows-board-meta-reads-do-not-scan: clause 2: EXPLAIN QUERY PLAN of every board_meta read claimRows makes shows no SCAN of board_meta [C7,#10858]', t => {
  const { board, id } = setup(t);
  const reads = [];
  const prepare = board.db.prepare.bind(board.db);
  board.db.prepare = sql => {
    const statement = prepare(sql);
    if (!/board_meta/u.test(sql)) return statement;
    return { all: (...args) => { reads.push({ sql, args }); return statement.all(...args); }, get: (...args) => { reads.push({ sql, args }); return statement.get(...args); } };
  };
  claimRows(board, id);
  board.db.prepare = prepare;
  assert.ok(reads.length > 0, 'claimRows reads board_meta');
  for (const { sql, args } of reads) {
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail);
    assert.ok(!plan.some(detail => /^SCAN board_meta/u.test(detail)), `no scan of board_meta in: ${plan.join(' | ')}`);
  }
});
