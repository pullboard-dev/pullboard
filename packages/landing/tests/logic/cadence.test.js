/** Opt-in landing cadence reads native acceptance times at both exact clock boundaries, on a board seeded with real verdict rows [E30,E10,E29]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../config/index.js';
import * as store from '../../../store/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { landingCadenceStatus } from '../../index.js';

// fixture-subject: addItem (a unit test of the cadence observer over seeded items; the board is opened through the kit)

const EVERY = 600_000;
const FIRST = Date.parse('2026-01-01T00:00:00Z');
const LATEST = FIRST + 60_000;

/** Run a raw status write under the move token the board's status trigger requires. */
function asMove(board, sql, ...args) {
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try { board.db.prepare(sql).run(...args); } finally { board.db.exec('DELETE FROM temp.moving'); }
}

/** Seed one item that a second agent accepted at a given time, with the verdict row the board's verified rule needs. */
function acceptedAt(board, title, at) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title });
  const commit = String(id).padStart(40, 'a');
  board.db.prepare('UPDATE item SET item_frozen_digest = ? WHERE item_id = ?').run('digest', id);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (?, 'web-6', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, 'digest', ?, ?)`).run(id, commit, commit, new Date(at).toISOString());
  asMove(board, "UPDATE item SET item_status = 'verified', item_verified_by = 'web-6', item_built_by = 'web-5', item_commit = ? WHERE item_id = ?", commit, id);
  return id;
}

test('landing.cadence.landing-cadence-is-opt-in-and: clause 1: landing cadence is opt-in and validates both compatible policy forms [E30,E29]', () => {
  assert.equal(configFromSource('{}').landing?.cadence, undefined);
  assert.equal(configFromSource('{"landing":{"cadence":"10m"}}').landing.cadenceMs, EVERY);
  assert.equal(configFromSource('{"landing":{"cadence":{"every":"10m","accepted":5}}}').landing.cadenceMs, EVERY);
  for (const cadence of [{ every: '0m', accepted: 5 }, { every: '10m', accepted: 0 }, { every: '10m', accepted: 1.5 },
    { every: '10m' }, [], null]) {
    assert.throws(() => configFromSource(JSON.stringify({ landing: { cadence } })), /BAD_CONFIG/u);
  }
  // An unknown key is a future setting: the validator ignores it and keeps the known policy [N26, forward-compat, f226542983].
  assert.equal(configFromSource('{"landing":{"cadence":{"every":"10m","accepted":5,"extra":true}}}').landing.cadenceMs, EVERY);
});

test('landing.cadence.cadence-thresholds-read-native-acceptance-times: clause 2: cadence thresholds read native acceptance times at both exact clock boundaries [E30,E10,E29]', t => {
  const board = cellBoard(t, ':memory:');
  acceptedAt(board, 'first', FIRST);
  acceptedAt(board, 'second', LATEST);
  assert.equal(landingCadenceStatus(board, configFromSource('{}')).due, false, 'even accepted waiting work does not enable the default-off policy');
  const agePolicy = configFromSource(JSON.stringify({ landing: { cadence: { every: '10m', accepted: 3 } } }));
  board.clock = { now: () => new Date(FIRST - 1) };
  assert.equal(landingCadenceStatus(board, agePolicy).oldestWaitMs, 0, 'a clock before acceptance clamps the observed age to zero');
  board.clock = { now: () => new Date(FIRST + EVERY - 1) };
  assert.equal(landingCadenceStatus(board, agePolicy).due, false, 'one millisecond before the age boundary and below count');
  board.clock = { now: () => new Date(FIRST + EVERY) };
  assert.equal(landingCadenceStatus(board, agePolicy).due, true, 'exactly at the oldest acceptance boundary');
  board.clock = { now: () => new Date(LATEST) };
  const countPolicy = configFromSource(JSON.stringify({ landing: { cadence: { every: '10m', accepted: 2 } } }));
  assert.equal(landingCadenceStatus(board, countPolicy).due, true, 'exactly at count, without waiting for age');
  assert.equal(landingCadenceStatus(board, agePolicy).due, false, 'one item below the configured count');
  const duration = configFromSource(JSON.stringify({ landing: { cadence: '10m' } }));
  assert.equal(landingCadenceStatus(board, duration).due, false);
  board.clock = { now: () => new Date(FIRST + EVERY) };
  assert.equal(landingCadenceStatus(board, duration).due, true, 'duration form also supplies the due age');
});
