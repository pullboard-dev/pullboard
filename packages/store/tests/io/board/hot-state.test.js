/** board.hotState keeps open and recent items in the built state and counts older finished ones [C7,#9725]. @pullboard-test-input source-cell store */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOT_RECENT_MS } from '../../../src/io/board/state.js';
import { hotStateItems } from '../../../src/io/board/state.js';
import { buildLocalBoardState } from '../../../src/io/board/state.js';
import { EVENT_PAGE_ROWS } from '../../../src/io/board/state.js';
import { events } from '../../../index.js';
import { listItems } from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { temporaryRepository } from '../../fixtures/submit.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 24 * 3600_000;
const at = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

/** A built state: two open items, one fresh and two stale finished items, and the fields a build carries besides items. */
function built() {
  return {
    board: 'main',
    agents: [{ agent_id: 'core-1' }],
    items: [
      { id: 1, status: 'open', updatedAt: at(90) },
      { id: 2, status: 'claimed', updatedAt: at(40) },
      { id: 3, status: 'withdrawn', updatedAt: at(1) },
      { id: 4, status: 'withdrawn', updatedAt: at(30) },
      { id: 5, status: 'withdrawn', updatedAt: at(60) },
    ],
  };
}

test('store.io-board-hot-state.with-board-hotstate-on-the-state: clause 1: with board.hotState on the state holds only open and recent items and counts the finished ones as the full build reports them [C7,#9725]', () => {
  const full = built();
  const hot = hotStateItems(built(), { enabled: true, now: NOW });
  assert.deepEqual(hot.items.map(item => item.id), [1, 2, 3], 'open items and the recently finished item stay whole');
  const finishedInFull = full.items.filter(item => item.status === 'withdrawn' && NOW - Date.parse(item.updatedAt) > HOT_RECENT_MS);
  assert.deepEqual(hot.finishedCounts, { withdrawn: finishedInFull.length }, 'the count equals the finished items the full build holds');
  assert.equal(hot.items.length + Object.values(hot.finishedCounts).reduce((sum, n) => sum + n, 0), full.items.length, 'every item is kept or counted');
  assert.equal(hot.board, 'main', 'the rest of the state is untouched');
  assert.deepEqual(hot.agents, full.agents);
});

test('store.io-board-hot-state.with-board-hotstate-off-the-state: clause 2: with board.hotState off the state is identical to today, with no new field [C7,#9725]', () => {
  const state = built();
  const off = hotStateItems(state, { enabled: false, now: NOW });
  assert.equal(off, state, 'the same object comes back');
  assert.deepEqual(off, built());
  assert.equal('finishedCounts' in off, false);
  assert.equal(hotStateItems(built(), { enabled: undefined, now: NOW }).finishedCounts, undefined, 'only an exact true turns it on');
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

/** A board of `count` events over 50 items, written straight to the tables with the machine guards dropped for the seed, then put back. */
function eventBoard(t, count) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(NOW) });
  const guards = board.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
  for (const { name } of guards) board.db.exec(`DROP TRIGGER "${name}"`);
  board.db.exec('BEGIN');
  try {
    const item = board.db.prepare("INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at) VALUES ('core', ?, 'open', 'coordinator', ?, ?)");
    const ids = Array.from({ length: 50 }, (_, index) => Number(item.run(`item ${index}`, at(30), at(1)).lastInsertRowid));
    const event = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', ?, ?, ?)");
    for (let index = 0; index < count; index += 1) event.run(at(30 - (index * 29) / count), index < ids.length ? 'add' : 'note', ids[index % ids.length], JSON.stringify({ step: index }));
    board.db.exec('COMMIT');
  } finally { for (const { sql } of guards) board.db.exec(sql); }
  return board;
}

/** The board seen through a db that counts the rows each read of the event tables hands back; `reads` lists one row count per read. */
function countingBoard(board) {
  const reads = [];
  const bound = (target, key) => (typeof target[key] === 'function' ? target[key].bind(target) : target[key]);
  const statement = (sql, prepared) => {
    if (!/\bFROM\s+event(_archive)?\b/iu.test(sql)) return prepared;
    return new Proxy(prepared, { get(target, key) {
      if (key === 'all') return (...args) => { const rows = target.all(...args); reads.push(rows.length); return rows; };
      if (key === 'get') return (...args) => { const row = target.get(...args); reads.push(row === undefined ? 0 : 1); return row; };
      if (key === 'iterate') return (...args) => { const rows = [...target.iterate(...args)]; reads.push(rows.length); return rows[Symbol.iterator](); };
      return bound(target, key);
    } });
  };
  const db = new Proxy(board.db, { get(target, key) {
    if (key === 'prepare') return sql => statement(sql, target.prepare(sql));
    return bound(target, key);
  } });
  return { board: Object.assign(Object.create(board), { db }), reads };
}

test('store.io-board-hot-state.state-build-reads-events-in-pages: clause 1: buildLocalBoardState on a board of 200,000 events never asks SQLite for more than 5,000 event rows in one read and returns the same state as before [C7,#13009]', t => {
  const count = 200_003;
  const board = eventBoard(t, count);
  const repo = temporaryRepository(t, 'pullboard-state-pages-');
  const build = (on, options = {}) => buildLocalBoardState(repo, 'main', on, true, { observedAt: NOW, ...options }, PORTS);
  // Before: the whole log in one read, as the build took it, handed in as the kept history so the build reads no event row past it.
  const whole = events(board);
  assert.equal(whole.length, count);
  const before = build(board, { previousHistory: whole });
  for (const kept of [null, whole.slice(0, 100_001)]) {
    const { board: counted, reads } = countingBoard(board);
    const after = build(counted, { previousHistory: kept });
    assert.ok(Math.max(...reads) <= EVENT_PAGE_ROWS, `largest event read was ${Math.max(...reads)} rows`);
    assert.ok(EVENT_PAGE_ROWS <= 5000, 'the page is at most 5,000 rows');
    const paged = reads.filter(rows => rows === EVENT_PAGE_ROWS).length;
    assert.ok(paged >= Math.floor((count - (kept?.length ?? 0)) / EVENT_PAGE_ROWS), `the log came back in pages (${paged} full pages)`);
    assert.deepEqual(after.history, whole, 'the history holds every event in order');
    assert.deepEqual(after.state, before.state, 'the state is the one the whole read built');
    assert.deepEqual(after.itemMeta, before.itemMeta);
    assert.deepEqual(after.clockWindow, before.clockWindow);
    assert.equal(after.sequence, before.sequence);
  }
});
