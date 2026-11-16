/** With runs_store on, claim sizes N from runner slots in a runs snapshot read before its board write; off, from the board's job rows as on main [B2,#9015]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { cellClaim } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellRepo } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';
import { claimAdmission } from '../../../index.js';
import { claimsPerSeat } from '../../../index.js';
import { createJob } from '../../../../jobs/index.js';
import { takeJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';

/** A runner r1 that declared 4 jobs a moment ago and holds one live job: 3 free slots. */
function serve(db, at) {
  createJob(db, { id: 'gate:1', kind: 'gate', now: at - 2000 });
  writeStep(db, 'gate:1', 'claimed', { runner: 'r1', jobs: 4 }, { now: at - 1500 });
  takeJob(db, 'gate:1', 'r1', { now: at - 1000 });
}

/** A file board with one seat and one open item, and the clock's now. */
function setup(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  return { repo, board, seat, item: item.item_id, at: board.clock.now().getTime() };
}

test('clause 1: with runs_store on, the claim\'s N takes runner slots from a runs snapshot read before the board write opens [B2,#9015]', t => {
  const { board, seat, item, at } = setup(t);
  const runs = { db: cellBoard(t, ':memory:').db };
  serve(runs.db, at);
  // The board holds a different, larger picture; the snapshot is what counts.
  createJob(board.db, { id: 'old:1', kind: 'gate', now: at - 2000 });
  writeStep(board.db, 'old:1', 'claimed', { runner: 'rb', jobs: 5 }, { now: at - 1500 });
  assert.equal(claimsPerSeat(board, null, { runs }).n, 3, 'N = floor(3 free runner slots / 1 seat)');
  assert.match(claimsPerSeat(board, null, { runs }).how, /3 free runner slots/u);
  assert.equal(claimAdmission(board, item, seat.id, null, { runs }).seatCap, 3);
  assert.equal(claimsPerSeat(board, null, { runs: { db: null } }).n >= 1, true, 'no runs file: the local cores size N');
});

test('clause 2: with runs_store on, no runs handle is opened inside the claim\'s board write [B2,#9015]', t => {
  const { repo, board, seat, item, at } = setup(t);
  const runsDb = cellBoard(t, ':memory:').db;
  serve(runsDb, at);
  let opened = 0;
  const runs = { get db() { opened += 1; return runsDb; } };
  const admission = claimAdmission(board, item, seat.id, null, { runs });
  assert.equal(opened, 1, 'the snapshot opens the handle once, before the claim');
  cellClaim(board, item, seat, { root: repo.root, itemFolder: true, seatCap: admission.seatCap, gateWaits: admission.gateWaits });
  assert.equal(opened, 1, 'the claim itself opened no runs handle');
  const logged = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'claim' ORDER BY event_id DESC").get();
  assert.equal(JSON.parse(logged.event_detail).claimsPerSeat, 3, 'the claim records the N the snapshot sized');
});

test('clause 3: with runs_store off, the claim computes runner slots from the board\'s job rows as on main [B2,#9015]', t => {
  const { board, seat, item, at } = setup(t);
  serve(board.db, at);
  assert.equal(claimsPerSeat(board).n, 3);
  assert.equal(claimsPerSeat(board, null, { runs: null }).n, 3);
  assert.equal(claimAdmission(board, item, seat.id, null).seatCap, 3);
  assert.equal(claimAdmission(board, item, seat.id, null, { runs: null }).seatCap, 3);
  assert.equal(claimsPerSeat(board, 2).n, 2, 'claims.perSeat still wins');
});
