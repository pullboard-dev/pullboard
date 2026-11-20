/** @pullboard-test-input source-cell store */
/** On a seeded 100-day board the archiver leaves only open and recent events hot, and show, log and export read an archived thread as before [C7,#11004]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveOldEvents } from '../../../index.js';
import { buildLocalBoardState } from '../../../src/io/board/state.js';
import { closeBoard } from '../../../index.js';
import { events } from '../../../index.js';
import { exportBoard } from '../../../index.js';
import { itemThread } from '../../../index.js';
import { listItems } from '../../../index.js';
import { stats } from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryRepository } from '../../fixtures/submit.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const DAYS = 100;
/** An ISO time the given days before the fake clock. */
const ago = days => new Date(NOW.getTime() - days * DAY).toISOString();

/** Run `work` with the board file's machine guards dropped, then put back exactly the SQL they had; the fixture files items no move reached. */
function unguarded(db, work) {
  const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
  for (const { name } of guards) db.exec(`DROP TRIGGER "${name}"`);
  try { work(); } finally { for (const { sql } of guards) db.exec(sql); }
}

/** One item per day for 100 days, three events each: every tenth day's item is open, the rest verified that day. */
function hundredDayBoard(t, days = Array.from({ length: DAYS }, (_, index) => index + 1)) {
  const directory = temporaryDirectory('pullboard-event-archive-hundred-');
  const board = openKitBoard(join(directory, 'board.sqlite'));
  t.after(() => { closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const item = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at)
    VALUES ('core', ?, ?, 'coordinator', ?, ?)`);
  const event = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', ?, ?, ?)");
  const items = [];
  unguarded(board.db, () => {
    for (const day of days) {
      const status = day % 10 === 0 ? 'open' : 'verified';
      const id = Number(item.run(`day ${day}`, status, ago(day + 1), ago(day)).lastInsertRowid);
      items.push({ id, day, status, archived: status === 'verified' && day > 30 });
      for (const [index, kind] of ['add', 'note', 'accept'].entries()) event.run(ago(day + 1 - index / 4), kind, id, JSON.stringify({ day, step: index }));
    }
  });
  return { board, items };
}

test('store.io-board-event-archive-hundred-day.hot-table-keeps-open-and-recent: clause 1: after the archiver ran on a 100-day board, the event table holds only events of open and recently verified items and event_archive holds every older verified item event [C7,#11004]', t => {
  const { board, items } = hundredDayBoard(t);
  const older = items.filter(row => row.archived);
  const kept = items.filter(row => !row.archived);
  assert.ok(older.length > 50 && kept.length > 20, 'the seed has both kinds');
  assert.equal(archiveOldEvents(board, NOW, { enabled: true }).moved, older.length * 3);
  const hot = board.db.prepare('SELECT item_id, COUNT(*) AS n FROM event GROUP BY item_id').all();
  assert.deepEqual(hot.map(row => row.item_id).sort((a, b) => a - b), kept.map(row => row.id).sort((a, b) => a - b), 'only open and recent items stay hot');
  assert.ok(hot.every(row => row.n === 3), 'each kept item keeps all three events');
  const cold = board.db.prepare('SELECT item_id, COUNT(*) AS n FROM event_archive GROUP BY item_id').all();
  assert.deepEqual(cold.map(row => row.item_id).sort((a, b) => a - b), older.map(row => row.id).sort((a, b) => a - b), 'every older verified item is archived');
  assert.ok(cold.every(row => row.n === 3), 'each archived item has all three events');
});

test('store.io-board-event-archive-hundred-day.show-log-export-read-same: clause 2: on the 100-day board, events (log), itemThread (show) and exportBoard read an archived item thread identically to before archiving [C7,#11004]', t => {
  const { board, items } = hundredDayBoard(t);
  const older = items.filter(row => row.archived);
  const before = new Map(items.map(row => [row.id, { log: events(board, { itemId: row.id }), thread: itemThread(board, row.id) }]));
  const exportedBefore = exportBoard(board);
  archiveOldEvents(board, NOW, { enabled: true });
  for (const row of items) {
    assert.deepEqual(events(board, { itemId: row.id }), before.get(row.id).log, `log of day ${row.day}`);
    assert.deepEqual(itemThread(board, row.id), before.get(row.id).thread, `thread of day ${row.day}`);
  }
  const exported = exportBoard(board);
  const archivedIds = new Set(older.map(row => row.id));
  assert.equal(exported.tables.event.some(row => archivedIds.has(row.item_id)), false, 'the export event table lacks archived rows');
  const everyEvent = id => [...exported.tables.event, ...exported.tables.event_archive].filter(row => row.item_id === id).map(row => row.event_id).sort((a, b) => a - b);
  for (const row of older) assert.deepEqual(everyEvent(row.id), before.get(row.id).log.map(entry => entry.event_id), `export of day ${row.day}`);
  assert.equal(exported.tables.event.length + exported.tables.event_archive.length, exportedBefore.tables.event.length, 'the export holds every event once');
});

/** The explicit upper presentation ports a state build needs, reduced to what a listing of items reads. */
const PORTS = {
  openBoard: () => null,
  verifiedPasskeyRowDecision: () => null,
  pendingFit: () => ({}),
  projectFit: (_pending, state) => state,
  projectState: (_root, { board, itemProjector }) => ({ agents: [], spec: [], practice: [],
    items: listItems(board, { all: true }).map(item => itemProjector(item, { project: () => ({ id: item.item_id, status: item.item_status, history: [], verdicts: [], merged: false }) })) }),
  personRequestStatuses: () => [],
  personSigningPresentation: () => ({}),
  activeViewAgents: agents => agents,
  viewProofSummary: summary => summary,
  claimHealthSnapshot: () => new Map(),
};

/** The median of five timed runs of `work`, in milliseconds. */
function medianOfFive(work) {
  const times = [];
  for (let run = 0; run < 5; run += 1) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[2];
}

test('store.io-board-event-archive-hundred-day.parity-measure: clause 1: a 100-day board after archiving and a 10-day board with the same open items both answer the status read and the default state build, and one parity line prints both medians and their ratio [C7,#12395]', t => {
  const repo = temporaryRepository(t, 'pullboard-event-archive-parity-');
  const openDays = Array.from({ length: DAYS / 10 }, (_, index) => (index + 1) * 10);
  const tenDays = [...Array.from({ length: 10 }, (_, index) => index + 1), ...openDays.filter(day => day > 10)];
  const long = hundredDayBoard(t);
  const short = hundredDayBoard(t, tenDays);
  assert.ok(archiveOldEvents(long.board, NOW, { enabled: true }).moved > 0, 'the 100-day board archived its older events');
  const build = board => buildLocalBoardState(repo, 'main', board, true, { observedAt: NOW.getTime() }, PORTS).state;
  for (const { board } of [long, short]) {
    assert.equal(stats(board).items.open, openDays.length, 'the status read answers with the same open items');
    assert.ok(build(board).items.length >= openDays.length, 'the default state build answers with items');
  }
  const statusLong = medianOfFive(() => stats(long.board));
  const statusShort = medianOfFive(() => stats(short.board));
  const stateLong = medianOfFive(() => build(long.board));
  const stateShort = medianOfFive(() => build(short.board));
  const ratio = (long_, short_) => (long_ / short_).toFixed(2);
  console.log(`# parity status median 100-day ${statusLong.toFixed(2)} ms, 10-day ${statusShort.toFixed(2)} ms, ratio ${ratio(statusLong, statusShort)}; state build median 100-day ${stateLong.toFixed(2)} ms, 10-day ${stateShort.toFixed(2)} ms, ratio ${ratio(stateLong, stateShort)}`);
});
