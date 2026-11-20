/** @pullboard-test-input source-cell store */
/** The claimed-by-owner index reaches every board on its next open without a shape-drift line: it is additive, never in SCHEMA [C7,#10876,#11000]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../index.js';
import { register } from '../../../index.js';
import { openBoardForRead } from '../../../index.js';
import { boardStanding } from '../../../index.js';
import { recordSchemaStamp } from '../../../index.js';
import { schemaDigest } from '../../../index.js';
import { SCHEMA } from '../../../index.js';
import { SCHEMA_DIGEST } from '../../../index.js';
import { SCHEMA_VERSION } from '../../../index.js';
import { EVENT_LOG_VERSION } from '../../../index.js';
import { addItem } from '../../../index.js';
import { getItem } from '../../../index.js';
import { reserveItem } from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

/** The exit guard's claimed-by-owner query exactly as requireExitActive runs it. */
const OWNER_LOOKUP = "SELECT item_id FROM item WHERE item_status = 'claimed' AND item_owner = ?";
/** The line #10876 (644b2ee538) put into SCHEMA, after the lane index. */
const LANE_LINE = '  CREATE INDEX IF NOT EXISTS item_lane_status ON item (item_lane, item_status);\n';
const OWNER_LINE = '  CREATE INDEX IF NOT EXISTS item_owner_status ON item (item_owner, item_status);\n';

/** The three columns #9181 added to SCHEMA and ADDED_COLUMNS without a version bump. */
const RESERVATION_COLUMNS = ['item_reservation_holder', 'item_reservation_by', 'item_reservation_at'];

/** The item table's column names, read without pullboard. */
function itemColumns(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('PRAGMA table_info(item)').all().map(column => column.name); } finally { db.close(); }
}

/** A real board file with one registered seat, as this code leaves it. */
function boardFile(t) {
  const directory = temporaryDirectory('pullboard-owner-index-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openKitBoard(file);
  try { register(board, { lane: 'coordinator', path: directory }); } finally { closeBoard(board); }
  return file;
}

/** Change the board file with plain SQLite, as older pullboard code would have left it. */
function rewrite(file, work) {
  const db = new DatabaseSync(file);
  try { work(db); } finally { db.close(); }
}

/** The board file's standing against this code, whether it has the index, and its row counts, read without pullboard. */
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      standing: boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION),
      index: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'item_owner_status'").get()),
      agents: db.prepare('SELECT count(*) AS n FROM agent').get().n,
      items: db.prepare('SELECT count(*) AS n FROM item').get().n,
      events: db.prepare('SELECT count(*) AS n FROM event').get().n,
    };
  } finally { db.close(); }
}

/** Open the board through openBoardStore's main path, collecting every shape-drift line it prints. */
function openMain(file) {
  const lines = [];
  closeBoard(openKitBoard(file, undefined, { onDiagnostic: line => lines.push(line) }));
  return lines.filter(line => /different shape/u.test(line));
}

test('store.io-board-indexes.pre-owner-index-board-opens-current: clause 1: a board stamped before the owner index opens current through openBoardStore, gains the index and keeps its rows; openBoardForRead then reports current, not drifted [C7]', t => {
  const file = boardFile(t);
  // The board as the code before #10876 left it: no owner index, stamped with that code's digest, which SCHEMA has again.
  rewrite(file, db => { db.exec('DROP INDEX item_owner_status'); recordSchemaStamp(db, SCHEMA_DIGEST); });
  const before = inspect(file);
  assert.equal(before.index, false);
  assert.equal(before.standing, 'current');
  assert.deepEqual(openMain(file), []);
  const after = inspect(file);
  assert.equal(after.standing, 'current');
  assert.equal(after.index, true);
  assert.equal(after.agents, before.agents);
  assert.equal(after.items, before.items);
  assert.ok(after.events >= before.events);
  const read = openBoardForRead(file);
  try {
    assert.equal(read.current, true);
    assert.equal(read.drifted, false);
  } finally { closeBoard(read); }
});

test('store.io-board-indexes.owner-index-in-schema-board-opens-current: clause 2: a board made by #10876 code, with the index in its table schema and that digest in its stamp, reopens current with no shape-drift line [C7]', t => {
  const file = boardFile(t);
  assert.equal(SCHEMA.split(LANE_LINE).length, 2, 'SCHEMA still has the lane index line #10876 followed');
  const digest10876 = schemaDigest(SCHEMA.replace(LANE_LINE, LANE_LINE + OWNER_LINE), EVENT_LOG_VERSION);
  rewrite(file, db => { db.exec(`DROP INDEX item_owner_status; ${OWNER_LINE}`); recordSchemaStamp(db, digest10876); });
  const before = inspect(file);
  assert.equal(before.standing, 'drifted');
  assert.deepEqual(openMain(file), []);
  const after = inspect(file);
  assert.equal(after.standing, 'current');
  assert.equal(after.index, true);
  assert.equal(after.agents, before.agents);
  assert.equal(after.items, before.items);
});

test('store.io-board-indexes.fresh-board-owner-index: clause 3: a fresh board answers the claimed-by-owner lookup with item_owner_status, and SCHEMA no longer names that index [C7]', t => {
  const file = boardFile(t);
  assert.doesNotMatch(SCHEMA, /item_owner_status/u);
  assert.equal(inspect(file).standing, 'current');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${OWNER_LOOKUP}`).all('someone').map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH item USING (?:COVERING )?INDEX item_owner_status/u);
    assert.doesNotMatch(plan, /SCAN item/u);
  } finally { db.close(); }
});

test('store.io-board-indexes.pre-reservation-board-opens-current: clause 1: a board stamped before the reservation columns opens current through openBoardStore, gains the three columns and keeps its rows; openBoardForRead then reports current [C7]', t => {
  const file = boardFile(t);
  // The board as the code before #9181 left it: no reservation columns, stamped with that code's digest, which SCHEMA has again.
  rewrite(file, db => { for (const column of RESERVATION_COLUMNS) db.exec(`ALTER TABLE item DROP COLUMN ${column}`); recordSchemaStamp(db, SCHEMA_DIGEST); });
  const before = inspect(file);
  assert.deepEqual(itemColumns(file).filter(name => RESERVATION_COLUMNS.includes(name)), []);
  assert.equal(before.standing, 'current');
  assert.deepEqual(openMain(file), []);
  const after = inspect(file);
  assert.equal(after.standing, 'current');
  assert.deepEqual(itemColumns(file).filter(name => RESERVATION_COLUMNS.includes(name)), RESERVATION_COLUMNS);
  assert.equal(after.agents, before.agents);
  assert.equal(after.items, before.items);
  assert.ok(after.events >= before.events);
  const read = openBoardForRead(file);
  try {
    assert.equal(read.current, true);
    assert.equal(read.drifted, false);
  } finally { closeBoard(read); }
});

test('store.io-board-indexes.reservation-in-schema-board-opens-current: clause 2: a board made by #9181 code, with the columns in its table schema and that digest in its stamp, reopens current through repairDrift with no shape-drift line [C7]', t => {
  const file = boardFile(t);
  const line = '    item_hold_at TEXT,\n';
  assert.equal(SCHEMA.split(line).length, 2, 'SCHEMA still has the hold line #9181 followed');
  assert.doesNotMatch(SCHEMA, /item_reservation/u);
  const digest9181 = schemaDigest(SCHEMA.replace(line, line + RESERVATION_COLUMNS.map(column => `    ${column} TEXT,\n`).join('')), EVENT_LOG_VERSION);
  rewrite(file, db => recordSchemaStamp(db, digest9181));
  const before = inspect(file);
  assert.equal(before.standing, 'drifted');
  assert.deepEqual(itemColumns(file).filter(name => RESERVATION_COLUMNS.includes(name)), RESERVATION_COLUMNS);
  assert.deepEqual(openMain(file), []);
  const after = inspect(file);
  assert.equal(after.standing, 'current');
  assert.equal(after.agents, before.agents);
  assert.equal(after.items, before.items);
});

test('store.io-board-indexes.fresh-board-reservation-columns: clause 3: a fresh board has the three nullable reservation columns, SCHEMA no longer names them, and reserveItem still records a reservation [C7]', t => {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const brief = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'Reservable', route: 'mid', criterion: 'The private fixture proves the reservation.', brief, check: 'true' });
  assert.doesNotMatch(SCHEMA, /item_reservation/u);
  const columns = board.db.prepare('PRAGMA table_info(item)').all().filter(column => RESERVATION_COLUMNS.includes(column.name));
  assert.deepEqual(columns.map(column => column.name), RESERVATION_COLUMNS);
  assert.ok(columns.every(column => column.notnull === 0 && column.dflt_value === null));
  assert.equal(getItem(board, id).item_reservation_holder, null);
  reserveItem(board, id, { agentId: 'coordinator', holder: 'web-1' });
  const reserved = getItem(board, id);
  assert.equal(reserved.item_reservation_holder, 'web-1');
  assert.equal(reserved.item_reservation_by, 'coordinator');
  assert.ok(reserved.item_reservation_at);
});
