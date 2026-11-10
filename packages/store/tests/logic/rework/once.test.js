/**
 * A seat's model family is recorded once and read from the record, never derived again from the session, events and
 * receipts on every claim and renew [H24].
 */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { openCellBoard as openBoard } from '../../fixtures/cell.js';
import { closeCellBoard as closeBoard } from '../../fixtures/cell.js';
import {
  derivedFamily,
  FAMILY_RECORD_PREFIX,
  seatFamily,
  withDerivedFamilies,
} from '../../../../items/index.js';
import {
  listAgents,
  exportBoard,
  importBoard,
  register,
} from '../../../index.js';

const BUDGET_MS = 20;

/** A board with 40 seats in ten sessions of four: each session's first seat declares the family, its peers name none. */
function fortySeats(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-family-once-')));
  const board = openBoard(join(dir, 'board.sqlite'));
  t.after(() => { closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  const seats = [];
  for (let session = 0; session < 10; session++) {
    for (let peer = 0; peer < 4; peer++) {
      const family = peer === 0 ? (session % 2 ? 'openai' : 'anthropic') : undefined;
      seats.push({ id: register(board, { lane: 'core', path: join(dir, `seat-${session}-${peer}`), family, model: 'test-model',
        session: `fixture-session-${session}` }), family: session % 2 ? 'openai' : 'anthropic' });
    }
  }
  const lone = register(board, { lane: 'core', path: join(dir, 'lone'), model: 'test-model', session: 'fixture-lone' });
  const unrelated = register(board, { lane: 'core', path: join(dir, 'unrelated'), model: 'test-model', session: 'fixture-unrelated' });
  return { board, seats, lone, unrelated };
}

/** The family record the board holds for one seat, parsed, or undefined. */
function record(board, id) {
  const value = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(FAMILY_RECORD_PREFIX + id)?.meta_value;
  return value === undefined ? undefined : JSON.parse(value);
}

test('a seat records its family once at join, its session peers included, and a seat with none records an unknown value [H24]', (t) => {
  const { board, seats, lone } = fortySeats(t);
  for (const seat of seats) {
    assert.equal(record(board, seat.id)?.family, seat.family, `${seat.id} records its family at join`);
    assert.equal(record(board, seat.id).family, derivedFamily(board, seat.id), `${seat.id}'s record is its derived family`);
  }
  assert.equal(record(board, lone)?.family, null, 'an unknown family is recorded without deriving it again');
  assert.equal(seatFamily(board, lone), null);
});

test('every family read comes from the record, tied to the seat row [H24]', (t) => {
  const { board, seats } = fortySeats(t);
  const [seat] = seats;
  const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(seat.id).agent_path;
  const put = (value) => board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(value), FAMILY_RECORD_PREFIX + seat.id);
  // A marker no event or receipt holds shows the read takes the record rather than deriving the family again.
  put({ family: 'recorded-only', path });
  assert.equal(seatFamily(board, seat.id), 'recorded-only');
  assert.equal(withDerivedFamilies(board, listAgents(board)).find(row => row.agent_id === seat.id).agent_family, 'recorded-only');
  // A record for another seat row, as after a forgotten seat's id is reused, is ignored and the family derived.
  put({ family: 'recorded-only', path: `${path}-elsewhere` });
  assert.equal(seatFamily(board, seat.id), seat.family);
});

test('claim and renew on a 40-seat board spend under 20 ms reading families [H24]', (t) => {
  const { board, seats } = fortySeats(t);
  const claimer = seats[5].id;
  const started = performance.now();
  // A claim and a renew each read the claimer's family and every seat's family for routing.
  for (let round = 0; round < 2; round++) {
    seatFamily(board, claimer);
    withDerivedFamilies(board, listAgents(board).filter(row => row.agent_id !== 'coordinator'));
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < BUDGET_MS, `family reads for a claim and a renew took ${elapsed.toFixed(1)} ms`); // budget: approved row H24 bar, under 20 ms on family per claim and renew
});


test('existing and rebuilt boards backfill old seats once without changing their family [H24]', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-family-old-')));
  const sourceFile = join(dir, 'source.sqlite'), copyFile = join(dir, 'copy.sqlite');
  let source = openBoard(sourceFile), copy;
  t.after(() => { if (source) closeBoard(source); if (copy) closeBoard(copy); rmSync(dir, { recursive: true, force: true }); });
  const first = register(source, { lane: 'core', path: join(dir, 'first'), family: 'openai', session: 'old-session' });
  const peer = register(source, { lane: 'core', path: join(dir, 'peer'), session: 'old-session' });
  const expected = [first, peer].map(id => derivedFamily(source, id));
  // Simulate a board made before the local projection existed, including its missing version marker.
  source.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(FAMILY_RECORD_PREFIX + '*');
  closeBoard(source); source = openBoard(sourceFile);
  for (const [index, id] of [first, peer].entries()) assert.equal(record(source, id)?.family, expected[index]);
  const snapshot = exportBoard(source);
  assert.ok(snapshot.tables.board_meta.every(row => !row.meta_key.startsWith(FAMILY_RECORD_PREFIX)));
  copy = openBoard(copyFile); importBoard(copy, snapshot);
  for (const [index, id] of [first, peer].entries()) assert.equal(record(copy, id)?.family, expected[index]);
  // A second open must leave the already recorded value in place, rather than derive it again.
  const path = source.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(first).agent_path;
  source.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify({ family: 'recorded-only', path }), FAMILY_RECORD_PREFIX + first);
  closeBoard(source); source = openBoard(sourceFile);
  assert.equal(seatFamily(source, first), 'recorded-only');
});


test('a later first declaration refreshes only its unknown session peers [H24]', t => {
  const { board, lone, unrelated } = fortySeats(t);
  assert.equal(seatFamily(board, lone), null);
  assert.equal(record(board, unrelated)?.family, null);
  register(board, { lane: 'core', path: '/later-family-peer', session: 'fixture-lone', family: 'openai' });
  assert.equal(seatFamily(board, lone), 'openai');
  assert.equal(record(board, lone)?.family, 'openai', 'the affected peer projection is restored in the declaring transaction');
  assert.equal(record(board, unrelated)?.family, null, 'unrelated unknown projections remain recorded while the warm marker stays valid');
});
