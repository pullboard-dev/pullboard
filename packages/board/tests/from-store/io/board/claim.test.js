/** @pullboard-test-input source-cell packages/board */
// fixture-subject: claimRows over a real board, with item-keyed board_meta rows for a check baseline, a bar revision, and a sign-off
/** A prepared claim reads its item's board_meta rows by exact key, with no scan of board_meta, and the same rows as the old LIKE read [C7,#10858,#5329]; a submit admission is stale only when its own rows move [C7,#10942]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { claimRows } from '../../../../../store/index.js';
import { admitSubmit } from '../../../../../store/index.js';
import { events } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellClaim } from '../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

/** The read claimRows made before: every board_meta key ending in :<id> or _<id>, with the two board-wide keys; the local: stats caches it also matched are derived from events, which claimRows reads by their last id. */
function legacyMeta(board, id) {
  return board.db.prepare(`SELECT meta_key,meta_value FROM board_meta WHERE meta_key IN ('row_decisions','bar_ready_setting')
    OR meta_key LIKE '%:' || ? OR meta_key LIKE '%\\_' || ? ESCAPE '\\' ORDER BY meta_key`).all(String(id), String(id)).map(row => ({ ...row })).filter(row => !row.meta_key.startsWith('local:'));
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

test('board.claim.claimrows-reads-same-rows-as-main: clause 1: claimRows returns the same item-keyed rows as the old LIKE read for an item with a check baseline, a bar revision, and a sign-off, and item 12 beside item 112 [C7,#10858]', t => {
  const { board, id, baseline } = setup(t);
  const meta = JSON.parse(claimRows(board, id)).meta;
  const keys = meta.map(row => row.meta_key);
  for (const key of [baseline, `bar_revision:${id}`, `bar_sign:${id}`, 'row_decisions', 'bar_ready_setting']) assert.ok(keys.includes(key), `${key} is read`);
  assert.deepEqual(meta, legacyMeta(board, id), 'the rows are the old read\'s rows');
  const twelve = JSON.parse(claimRows(board, 12)).meta.map(row => row.meta_key);
  assert.deepEqual(twelve, ['bar_ready_setting', 'bar_revision:12', 'bar_sign:12', 'item_check_baseline_12', 'row_decisions'], 'item 12 reads its own rows only');
  assert.ok(!twelve.some(key => key.endsWith('112')), 'item 112 rows do not leak into item 12');
});

test('board.claim.claimrows-board-meta-reads-do-not-scan: clause 2: EXPLAIN QUERY PLAN of every board_meta read claimRows makes shows no SCAN of board_meta [C7,#10858]', t => {
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

/**
 * A real board with a live claim, a second item, and a second connection that retitles `target` ('claimed' or 'other')
 * once, after the admission captured its claim rows and before it checks them: the race a pulled gate's admission meets
 * while other seats write.
 */
function admissionRace(t, target) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: `${project.dir}/builder` });
  const claimed = cellItem(board, { lane: 'web', title: 'Admission fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  const other = cellItem(board, { lane: 'web', title: 'Other fixture', specIds: ['G1'], route: 'strong', criterion: 'the other fixture works' }).item_id;
  cellClaim(board, claimed, seat, { root: project.repo });
  const foreign = new DatabaseSync(project.boardFile);
  foreign.exec('PRAGMA busy_timeout = 2000');
  t.after(() => foreign.close());
  const prepare = board.db.prepare.bind(board.db);
  let rowsRead = false, written = false;
  board.db.prepare = text => {
    if (/^SELECT \* FROM item WHERE item_id=\?$/u.test(text)) rowsRead = true;
    else if (rowsRead && !written && text === 'PRAGMA data_version') { written = true; foreign.prepare('UPDATE item SET item_title = item_title || \' (edited)\' WHERE item_id = ?').run(target === 'claimed' ? claimed : other); }
    return prepare(text);
  };
  t.after(() => { board.db.prepare = prepare; });
  const witness = { id: randomUUID(), commit: 'c'.repeat(40), tree: 'e'.repeat(40) };
  const admit = () => admitSubmit(board, claimed, { agentId: seat.id, lane: 'web', leaseMs: 60_000, freeze: () => null, submitAdmission: witness });
  const witnessed = () => events(board, { itemId: claimed }).filter(row => ['claim', 'renew'].includes(row.event_kind) && JSON.parse(row.event_detail).submitAdmission?.id === witness.id);
  return { admit, witnessed, wrote: () => written, witness };
}

test('board.claim.admission-survives-unrelated-write: clause 1: a second connection writes another item between the admission preparation and its commit; admitSubmit records the witness instead of refusing BOARD_BUSY [C7,#10942]', t => {
  const race = admissionRace(t, 'other');
  race.admit();
  assert.equal(race.wrote(), true, 'the other connection wrote the board during the admission');
  const rows = race.witnessed();
  assert.equal(rows.length, 1, 'one claim event carries the admission witness');
  assert.deepEqual(JSON.parse(rows[0].event_detail).submitAdmission, race.witness, 'the witness names the admitted commit and tree');
});

test('board.claim.admission-refuses-own-row-write: clause 2: the same race on the claimed item own row still refuses BOARD_BUSY and records no witness [C7,#10942]', t => {
  const race = admissionRace(t, 'claimed');
  assert.throws(() => race.admit(), error => error?.code === 'BOARD_BUSY', 'a write to the claim\'s own rows makes the admission stale');
  assert.equal(race.wrote(), true, 'the other connection wrote the claimed item');
  assert.equal(race.witnessed().length, 0, 'no witness is recorded');
});
