/** A proven ledger flake files its repair and quarantine, and the landing ratchet accepts it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordFlakeObservation } from '../../../lib/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { withdraw } from '../../../../packages/store/index.js';
import { flakeLedger } from '../../../../packages/flakes/index.js';
import { flakeQuarantines } from '../../../../packages/flakes/index.js';
import { landingFlakeRatchet } from '../../../../packages/flakes/index.js';
import { LEDGER_QUARANTINE_ENGINE } from '../../../../packages/state/light.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { syntheticFlakeObservation } from '../../tests/fixtures/observation.js';

/** A typed flake observation (red original, green pair) for one named synthetic test. */
function flake(id, name) { return { ...syntheticFlakeObservation(id, true), name }; }

/** Record an observation the way a board before the ledger-quarantine engine did. */
function recordBeforeEngine(board, agentId, observation) {
  board.executionEngineVersion = LEDGER_QUARANTINE_ENGINE - 1;
  try { return recordFlakeObservation(board, { agentId, lane: 'core', observation }); }
  finally { delete board.executionEngineVersion; }
}

/** A coordinator board with one core seat; the caller closes it. */
function fixture(t) {
  const { board, builder } = boardFixture();
  t.after(() => closeBoard(board));
  return { board, coordinator: 'coordinator', seat: builder };
}

/** The active quarantine for one synthetic test name, if any. */
function quarantineOf(board, name) { return flakeQuarantines(board).find(row => row.name === name && row.status === 'quarantined'); }

test('a flake observation files a repair and a quarantine for every unprotected ledger flake, older rows included [C7]', t => {
  const { board, seat } = fixture(t);
  recordBeforeEngine(board, seat, flake('old-sighting', 'old flake'));
  assert.equal(quarantineOf(board, 'old flake'), undefined, 'the older engine leaves the single sighting unquarantined');
  assert.deepEqual(landingFlakeRatchet(board).unprotected.map(row => row.name), ['old flake'], 'which blocks every landing');

  const result = recordFlakeObservation(board, { agentId: seat, lane: 'core', observation: flake('new-sighting', 'new flake') });
  assert.deepEqual(result.quarantined.map(row => row.name).sort(), ['new flake', 'old flake']);
  for (const name of ['old flake', 'new flake']) {
    const quarantine = quarantineOf(board, name);
    assert.ok(quarantine, `${name} is quarantined`);
    assert.equal(quarantine.ledger, true);
    assert.equal(flakeLedger(board).find(row => row.name === name).item, quarantine.item, `${name} has one repair, recorded in the ledger`);
    assert.equal(getItem(board, quarantine.item).item_status, 'open');
  }
  assert.deepEqual(landingFlakeRatchet(board).unprotected, [], 'no ledger flake is left unprotected');

  // A second sighting of a quarantined test files nothing new.
  const again = recordFlakeObservation(board, { agentId: seat, lane: 'core', observation: flake('new-again', 'new flake') });
  assert.deepEqual(again.quarantined, []);
  assert.equal(flakeQuarantines(board).length, 2);
});

test('a ledger-backed quarantine of a flake older than the last landing does not block the next landing [C7]', t => {
  const { board, coordinator, seat } = fixture(t);
  recordBeforeEngine(board, seat, flake('old-sighting', 'old flake'));
  // A landing recorded after the old sighting, as the merged path does, with no quarantine yet.
  const landed = addItem(board, { by: coordinator, lane: 'core', title: 'Landed fixture', criterion: 'A landed fixture.' });
  const boundary = board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  logEvent(board, coordinator, 'merged', landed, { flakeRatchet: { version: 1, eventId: boundary, count: 0, quarantines: [] } });

  recordFlakeObservation(board, { agentId: seat, lane: 'core', observation: flake('new-sighting', 'new flake') });
  const ratchet = landingFlakeRatchet(board);
  assert.deepEqual(ratchet.unjustified, [], 'the old proof justifies its later quarantine');
  assert.deepEqual(ratchet.unprotected, []);
  assert.equal(ratchet.allowed, true);
  assert.equal(ratchet.snapshot.count, 2);
});

test('a ledger flake whose quarantine was lifted after its last sighting is not unprotected [C7]', t => {
  const { board, coordinator, seat } = fixture(t);
  recordFlakeObservation(board, { agentId: seat, lane: 'core', observation: flake('only-sighting', 'released flake') });
  const quarantine = quarantineOf(board, 'released flake');
  withdraw(board, quarantine.item, { agentId: coordinator, reason: 'Fixture: the repair is closed after the last sighting.' });
  assert.equal(flakeQuarantines(board).find(row => row.name === 'released flake').status, 'lifted');
  assert.deepEqual(landingFlakeRatchet(board).unprotected, [], 'the released row stays released');

  // A later observation of another test leaves the released one alone.
  const result = recordFlakeObservation(board, { agentId: seat, lane: 'core', observation: flake('other-sighting', 'other flake') });
  assert.deepEqual(result.quarantined.map(row => row.name), ['other flake']);
});
