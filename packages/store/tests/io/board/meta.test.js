/** Board meta prefix reads and deletes use a primary-key range, so their cost never grows with board history [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listBoardMetaWithPrefix } from '../../../index.js';
import { deleteBoardMetaWithPrefix } from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

const TOP = String.fromCodePoint(0x10ffff);
/** Prefixes that cover the plain, wildcard-looking and top-code-point bounds. */
const PREFIXES = ['after_gate:', 'push.timing.', 'odd%_key:', `top${TOP}`, `z${TOP}${TOP}`, 'key\u{d7ff}'];

/** Insert rows in one transaction. */
function insertRows(board, rows) {
  const insert = board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)');
  board.db.exec('BEGIN');
  try { for (const [key, value] of rows) insert.run(key, value); board.db.exec('COMMIT'); } catch (error) { board.db.exec('ROLLBACK'); throw error; }
}

/** Seed `rows` board_meta rows under keys no tested prefix matches, standing in for board history. */
function seedMetaHistory(board, rows) {
  const value = JSON.stringify({ history: 'x'.repeat(180) });
  insertRows(board, Array.from({ length: rows }, (_, index) => [`local:history-${index}`, value]));
}

/** Rows next to each prefix's bounds: inside, just outside below and above, and look-alikes a LIKE would match. */
function seedEdges(board) {
  const keys = [];
  for (const prefix of PREFIXES) {
    keys.push(prefix, `${prefix}1`, `${prefix}${TOP}`, `${prefix}${TOP}tail`, `${prefix}\u{e000}x`, prefix.slice(0, -1), `${prefix.slice(0, -1)}\u0000`);
  }
  keys.push('odd-x_key:1', 'oddAAkey:1', 'after_gate;', 'after_gatf', 'key\u{e000}', 'key\u{d7fe}z');
  insertRows(board, [...new Set(keys)].map((key, index) => [key, String(index)]));
}

/** Every row whose key starts with `prefix`, in meta_key order, read without the function under test. */
function startsWith(board, prefix) {
  return board.db.prepare('SELECT meta_key AS key, meta_value AS value FROM board_meta ORDER BY meta_key').all()
    .filter(row => row.key.startsWith(prefix)).map(row => ({ key: row.key, value: row.value }));
}

/** Record every statement `work` prepares on the board connection. */
function preparedBy(board, work) {
  const statements = [];
  const prepare = board.db.prepare.bind(board.db);
  board.db.prepare = sql => { statements.push(sql); return prepare(sql); };
  try { work(); } finally { delete board.db.prepare; }
  return statements;
}

/** The median milliseconds of repeated prefix reads. */
function medianReadMs(board, calls = 20) {
  const times = [];
  for (let index = 0; index < calls; index += 1) {
    const started = performance.now();
    listBoardMetaWithPrefix(board.db, 'after_gate:');
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

test('store.io-board-meta.prefix-read-uses-key-range: clause 1: listBoardMetaWithPrefix and deleteBoardMetaWithPrefix prepare no statement whose plan scans board_meta [C7]', (t) => {
  const board = fixtureBoard(t);
  seedEdges(board);
  const statements = preparedBy(board, () => {
    for (const prefix of PREFIXES) listBoardMetaWithPrefix(board.db, prefix);
    deleteBoardMetaWithPrefix(board.db, 'after_gate:');
  });
  assert.ok(statements.length >= PREFIXES.length + 1, 'the reads and the delete each prepare a statement');
  for (const sql of statements) {
    const binds = (sql.match(/\?/gu) ?? []).map(() => 'x');
    const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds).map(row => row.detail).join('\n');
    assert.doesNotMatch(plan, /SCAN board_meta/u, `${sql}\n${plan}`);
  }
});

test('store.io-board-meta.prefix-read-flat-with-history: clause 2: a prefix read stays under 20 ms and within 2x of an empty board with 81,559 board_meta history rows [C7]: 1:10 of the live board', (t) => {
  const empty = fixtureBoard(t);
  const full = fixtureBoard(t);
  seedMetaHistory(full, 81_559);
  medianReadMs(empty, 3); medianReadMs(full, 3);
  const base = medianReadMs(empty);
  const loaded = medianReadMs(full);
  assert.ok(loaded < 20, `median prefix read ${loaded.toFixed(2)} ms with history`);
  assert.ok(loaded <= Math.max(2 * base, base + 1), `median prefix read ${loaded.toFixed(2)} ms with history against ${base.toFixed(2)} ms without`);
});

test('store.io-board-meta.prefix-rows-unchanged: clause 3: prefix reads return and deletes remove exactly the rows whose keys start with the prefix, in key order [C7]', (t) => {
  const board = fixtureBoard(t);
  seedEdges(board);
  for (const prefix of PREFIXES) {
    assert.deepEqual(listBoardMetaWithPrefix(board.db, prefix).map(row => ({ ...row })), startsWith(board, prefix), `rows for ${JSON.stringify(prefix)}`);
  }
  for (const prefix of PREFIXES) {
    const others = board.db.prepare('SELECT meta_key FROM board_meta ORDER BY meta_key').all().map(row => row.meta_key).filter(key => !key.startsWith(prefix));
    deleteBoardMetaWithPrefix(board.db, prefix);
    assert.deepEqual(startsWith(board, prefix), [], `no rows left for ${JSON.stringify(prefix)}`);
    assert.deepEqual(board.db.prepare('SELECT meta_key FROM board_meta ORDER BY meta_key').all().map(row => row.meta_key), others, `other rows kept for ${JSON.stringify(prefix)}`);
  }
});
