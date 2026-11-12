/** Landing captures the flake ratchet from one read snapshot, so a busy board never refuses it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cellBoard,
  cellRepo,
  closeCellBoard,
} from '../../../store/tests/fixtures/cell.js';
import {
  gateRuns,
  landingFlakeRatchet,
} from '../../index.js';

/** A real git repo with a real SQLite board file holding one event; returns its root and board path. */
function realBoard(t) {
  const { root, boardFile: file } = cellRepo(t);
  const seed = cellBoard(t, file, undefined, { isMain: true, gitRoot: root });
  try { appendEvent(seed, 'Seed'); } finally { closeCellBoard(seed); }
  return { root, file };
}

/** Append one plain event to the board's log, the write another connection makes to a board in use. */
function appendEvent(board, note) {
  board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'coordinator', 'note', null, JSON.stringify({ note }));
}

test('a write from a second connection during the capture neither refuses it nor changes it from a quiet capture [C7]', t => {
  const { root, file } = realBoard(t);
  const reader = cellBoard(t, file, undefined, { isMain: true, gitRoot: root });
  const quiet = landingFlakeRatchet(reader);
  let wrote = 0;
  /** Read the runs, then write a new event from another connection before the capture's later queries. */
  const busyRuns = board => {
    const runs = gateRuns(board);
    const writer = cellBoard(t, file, undefined, { isMain: true, gitRoot: root });
    try { appendEvent(writer, 'Concurrent write'); wrote += 1; }
    finally { closeCellBoard(writer); }
    return runs;
  };
  const busy = landingFlakeRatchet(reader, { readRuns: busyRuns });
  assert.equal(wrote, 1, 'the second connection committed its write during the capture');
  assert.deepEqual(busy, quiet, 'the busy capture matches the quiet one: every query read the same snapshot');
  const latest = reader.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  assert.ok(latest > quiet.snapshot.eventId, 'the concurrent write is on the board after the capture');
  assert.equal(landingFlakeRatchet(reader).snapshot.eventId, latest, 'the next capture sees it');
});
