/** A move table's clean window starts at its later of first compare and last disagreement and is ready after 24 hours [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowReport } from '../../src/logic/moves-window.js';
import { movesReport } from '../../src/io/commands/moves.js';
import { DatabaseSync } from 'node:sqlite';
import { readShadow } from '../../../../packages/store/index.js';
import { recordShadow } from '../../../../packages/store/index.js';

const NOW = '2026-11-16T12:00:00.000Z';
const ago = hours => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

test('cli.logic-moves-window.windowreport-starts-at-the-later-of-first: clause 1: windowReport starts at the later of first compare and last disagreement and is ready only at 24 hours [C7]', () => {
  const clean = windowReport({ compared: 5, firstCompareAt: ago(30), lastDisagreedAt: null }, NOW, 24);
  assert.deepEqual([clean.windowStart, clean.windowHours, clean.ready], [ago(30), 30, true]);
  const fixed = windowReport({ compared: 9, firstCompareAt: ago(100), lastDisagreedAt: ago(26) }, NOW, 24);
  assert.equal(fixed.windowStart, ago(26));
  assert.equal(fixed.ready, true);
  assert.equal(windowReport({ compared: 5, firstCompareAt: ago(23.9) }, NOW, 24).ready, false);
  assert.equal(windowReport({ compared: 5, firstCompareAt: ago(24) }, NOW, 24).ready, true);
});

test('cli.logic-moves-window.a-table-that-disagreed-2-hours-ago: clause 2: a table that disagreed 2 hours ago is not ready though first compared 3 days ago, and one with no compares is not ready [C7]', () => {
  const recent = windowReport({ compared: 50, firstCompareAt: ago(72), lastDisagreedAt: ago(2) }, NOW, 24);
  assert.deepEqual([recent.windowStart, recent.windowHours, recent.ready], [ago(2), 2, false]);
  assert.deepEqual(windowReport({ compared: 0, firstCompareAt: null, lastDisagreedAt: null }, NOW, 24), { windowStart: null, windowHours: 0, ready: false });
});

test('cli.logic-moves-window.each-moves-row-carries-windowstart-windowhours-and: clause 3: each moves row carries windowStart, windowHours and ready beside the old keys [C7]', () => {
  const shadows = { claim: { compared: 4, disagreed: 1, since: ago(72), lastDisagreedAt: ago(30), last: [] } };
  const row = movesReport(shadows, ['claim', 'release'], {}, undefined, new Date(NOW)).find(entry => entry.table === 'claim');
  for (const key of ['table', 'state', 'liveSwitch', 'compared', 'disagreed', 'firstCompareAt', 'lastDisagreedAt', 'lastDisagreements']) assert.ok(key in row, `old key ${key} stays`);
  assert.deepEqual([row.windowStart, row.windowHours, row.ready], [ago(30), 30, true]);
  const none = movesReport({}, ['release'], {}, undefined, new Date(NOW))[0];
  assert.deepEqual([none.windowStart, none.windowHours, none.ready], [null, 0, false]);
});

{
  const NOW = '2026-11-17T12:00:00.000Z';
  const ago = hours => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

  /** A bare board holding only board_meta, the one table the recorder writes. */
  function metaBoard() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)');
    return { db, clock: { now: () => new Date(NOW) } };
  }

  test('clause 1: recordShadow adds 1 to windowCompared per agreeing compare and sets it to 0 on a disagreement [C7]', () => {
    const board = metaBoard();
    recordShadow(board, 'claim', 1, null);
    recordShadow(board, 'claim', 2, null);
    assert.equal(readShadow(board, 'claim').windowCompared, 2);
    recordShadow(board, 'claim', 3, 'events.0.detail.leaseUntil');
    assert.equal(readShadow(board, 'claim').windowCompared, 0);
    recordShadow(board, 'claim', 4, null);
    const counts = readShadow(board, 'claim');
    assert.deepEqual([counts.compared, counts.disagreed, counts.windowCompared], [4, 1, 1]);
    board.db.prepare('UPDATE board_meta SET meta_value = ? WHERE meta_key = ?').run(JSON.stringify({ compared: 9, disagreed: 0, since: ago(48), lastDisagreedAt: null, last: [] }), 'moves.shadow.reopen');
    recordShadow(board, 'reopen', 5, null);
    assert.equal(readShadow(board, 'reopen').windowCompared, 1, 'a record written before windowCompared starts counting at its next compare');
  });

  test('clause 2: a 24 h window holding 0 compares is not ready, 1 compare makes it ready, and a record without windowCompared keeps the time-only answer [C7]', () => {
    const row = { compared: 25, firstCompareAt: ago(72), lastDisagreedAt: ago(30) };
    assert.equal(windowReport({ ...row, windowCompared: 0 }, NOW, 24).ready, false);
    assert.equal(windowReport({ ...row, windowCompared: 1 }, NOW, 24).ready, true);
    assert.equal(windowReport(row, NOW, 24).ready, true);
    assert.equal(windowReport({ ...row, windowCompared: null }, NOW, 24).ready, true);
    assert.equal(windowReport({ ...row, lastDisagreedAt: ago(2), windowCompared: 40 }, NOW, 24).ready, false, 'compares never shorten the 24 h window');
  });

  test('clause 3: every movesReport row carries windowCompared, null when its record has none [C7]', () => {
    const shadows = { claim: { compared: 4, disagreed: 1, since: ago(72), lastDisagreedAt: ago(30), last: [], windowCompared: 3 },
      reopen: { compared: 25, disagreed: 4, since: ago(72), lastDisagreedAt: ago(30), last: [] } };
    const rows = movesReport(shadows, ['claim', 'reopen', 'release'], {}, undefined, new Date(NOW));
    for (const row of rows) assert.ok('windowCompared' in row, `${row.table} carries windowCompared`);
    const by = table => rows.find(row => row.table === table);
    assert.deepEqual([by('claim').windowCompared, by('reopen').windowCompared, by('release').windowCompared], [3, null, null]);
    assert.equal(by('claim').ready, true);
  });
}
