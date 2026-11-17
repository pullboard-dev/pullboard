/** @pullboard-test-input source-cell packages/flakes packages/store packages/config packages/state */
/** With flakes.rereadRatchet on, recording a landing batch re-reads a stale flake ratchet in its own transaction [C7,#9436]. */
// fixture-subject: addItem (a store unit test of recordLandingBatch over a seeded board)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { flakesRereadRatchetEnabled } from '../../../config/index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { FLAKE_RATCHET_ENGINE } from '../../../state/light.js';
import { NATIVE_FLAKE_ENGINE } from '../../../state/light.js';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { landingFlakeRatchet } from '../../index.js';

const BASE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const TRUNK = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const AT = '2026-10-16T00:00:00.000Z';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root } = privateFixtureFiles('pullboard-reread-ratchet-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A board with one submitted item, built through public operations only. */
function fixture(t) {
  const board = openBoard(':memory:', { now: () => new Date(AT) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/fixture' });
  store.register(board, { lane: 'web', path: '/fixture/web-1' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Reread fixture', criterion: 'Reread fixture' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: BASE,
    freeze: () => ({ text: JSON.stringify({ criterion: 'Reread fixture', rows: [], policy: { version: 1, commit: BASE, verify: { policy: 'any', family: 'off' } } }), digest: DIGEST }) });
  submitFixture(board, id, { agentId: 'web-1', commit: COMMIT, tree: TRUNK, files: ['web/feature.js'], policyCommit: BASE });
  return { board, id };
}

/** A batch revision-zero record carrying the given ratchet snapshot. */
function batchOf(id, item, flakeRatchet) {
  const entry = { id: item, commit: COMMIT };
  return { version: 1, id, state: 'gating', base: BASE, tip: COMMIT, branch: 'refs/heads/main', root: '/fixture/landing', owner: 'fixture',
    logPath: '/fixture/landing.log', candidates: [entry], items: [entry], revision: 0, flakeRatchet };
}

const record = (board, batch) => store.recordLandingBatch(board, { agentId: 'coordinator', batch });
const maxEvent = board => board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;

test('clause 3: flakes.rereadRatchet is off by default and on only for an exact true [C7,#9436]', () => {
  assert.equal(withSettings({}, flakesRereadRatchetEnabled), false);
  assert.equal(withSettings({ flakes: { rereadRatchet: true } }, flakesRereadRatchetEnabled), true);
  assert.throws(() => withSettings({ flakes: { rereadRatchet: 'yes' } }, flakesRereadRatchetEnabled), /flakes\.rereadRatchet/u);
});

test('clause 3: with the setting off, a snapshot that went stale refuses BOARD_BUSY as before [C7,#9436]', t => {
  const { board, id } = fixture(t);
  const stale = landingFlakeRatchet(board).snapshot;
  record(board, batchOf('first', id, stale));
  board.nativePorts.logEvent(board, 'coordinator', 'reopen', null, {});
  withSettings({}, () => assert.throws(() => record(board, batchOf('second', id, stale)), { code: 'BOARD_BUSY' }));
});

test('clause 1: with the setting on, a stale snapshot that still passes is re-read and recorded in the same transaction [C7,#9436]', t => {
  const { board, id } = fixture(t);
  const stale = landingFlakeRatchet(board).snapshot;
  record(board, batchOf('first', id, stale));
  board.nativePorts.logEvent(board, 'coordinator', 'reopen', null, {});
  const recorded = withSettings({ flakes: { rereadRatchet: true } }, () => record(board, batchOf('second', id, stale)));
  assert.equal(recorded.flakeRatchet.eventId, maxEvent(board) - 1, 'the fresh boundary is the last event before the record itself');
  assert.ok(recorded.flakeRatchet.eventId > stale.eventId);
});

test('clause 2: a fresh ratchet that fails refuses BOARD_BUSY, and a move below the ratchet engine keeps its old refusal [C7,#9436]', t => {
  const { board, id } = fixture(t);
  const stale = landingFlakeRatchet(board).snapshot;
  record(board, batchOf('first', id, stale));
  // A sighting written without the recording operation's repair and quarantine leaves a flake nothing protects.
  board.nativePorts.logEvent(board, 'web-1', 'flake-observation', null, { engine: NATIVE_FLAKE_ENGINE, observation: { id: 'reread-one', file: 'web/test.test.js',
    name: 'reread target', head: BASE, tree: COMMIT, main: BASE, kind: 'check', classification: 'flake' } });
  withSettings({ flakes: { rereadRatchet: true } }, () => {
    assert.equal(landingFlakeRatchet(board).allowed, false, 'the new sighting has no quarantine');
    assert.throws(() => record(board, batchOf('second', id, stale)), { code: 'BOARD_BUSY' });
    board.executionEngineVersion = FLAKE_RATCHET_ENGINE - 1;
    assert.throws(() => record(board, batchOf('third', id, stale)), { code: 'ENGINE_VERSION' });
  });
});
