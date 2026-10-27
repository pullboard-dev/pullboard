/** Line controls retain board authority, typed evidence and read-only inventory boundaries [R1,R2,H16,O5,O6]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { settingsInventory } from '../src/settings-inventory.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { LAND_COLLISION_ENGINE } from '../src/landing-collision-engine.js';
import { BAR_CHECK_ENGINE } from '../src/bar-check-engine.js';
import { LINE_SETTING_DEFINITIONS } from '../src/queue-settings.js';

/** A private SQLite board with coordinator and builder identities. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-line-setting-'));
  const board = store.openBoard(join(root, 'board.sqlite'));
  store.register(board, { lane: 'coordinator', path: root });
  store.register(board, { lane: 'web', path: join(root, 'web') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return board;
}

/** A valid typed change, with one deliberately unknown measurement. */
function change(overrides = {}) {
  return { agentId: 'coordinator', key: 'barReady', value: true, reason: 'PRIVATE_REASON_CANARY',
    window: { windowMinutes: 60, activeReviewers: 2, reviewMedianMinutes: null }, ...overrides };
}

test('line setting evidence and coordinator authority cannot be omitted or forged [R1,R2,H16]', t => {
  const board = fixture(t);
  const baseline = store.events(board).length;
  for (const [options, code] of [[change({ agentId: 'web-1' }), /COORDINATOR_ONLY/u],
    [change({ key: 'unknown' }), /LINE_SETTING_UNKNOWN/u], [change({ reason: '' }), /LINE_SETTING_REASON/u],
    [change({ reason: '  ' }), /LINE_SETTING_REASON/u], [change({ window: {} }), /LINE_SETTING_WINDOW/u],
    [change({ window: { count: -1 } }), /LINE_SETTING_WINDOW/u], [change({ window: { count: Infinity } }), /LINE_SETTING_WINDOW/u],
    [change({ window: { count: '2' } }), /LINE_SETTING_WINDOW/u]]) {
    assert.throws(() => store.setLineSetting(board, options), code);
    assert.equal(store.events(board).length, baseline);
    assert.equal(store.lineSettings(board).barReady, false);
  }
  const move = prepareEngineMove(board, 'setLineSetting', [change()], { id: 'line-auth-binding', actor: 'coordinator' });
  const refused = applyRelayMove(board, move, { sequence: 1, at: '2026-10-24T00:00:00Z', kind: 'move',
    sender: { kind: 'agent', agent: 'web-1', userId: 'fixture' } });
  assert.equal(refused.error.code, 'RELAY_SENDER_MISMATCH');
  assert.equal(store.lineSettings(board).barReady, false);
  assert.throws(() => applyRelayMove(board, { ...move, engine: 1 }, { sequence: 2, at: '2026-10-24T00:01:00Z', kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture' } }), /RELAY_MOVE/u, 'an old engine cannot reinterpret the new move');
  store.setLineSetting(board, change());
  store.setLineSetting(board, change({ value: false }));
  assert.equal(store.lineSettings(board).barReady, false, 'off is explicit and recorded, not a missing value');
  assert.equal(store.events(board).filter(event => event.event_kind === 'line_setting').length, 2);
});

test('the settings inventory exposes board line values and defaults without audit text [O5,O6,R1]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  let board;
  t.after(() => { if (board) store.closeBoard(board); helpers.cleanup(); });
  board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  store.setLineSetting(board, change({ key: 'wipPerReviewer', value: 2 }));
  const before = store.events(board).length;
  const previous = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].map(key => [key, process.env[key]]));
  let rows;
  try {
    for (const key of Object.keys(previous)) process.env[key] = box.env[key];
    rows = settingsInventory([{ root: box.repo }]).settings.filter(row => row.scope === 'board' && row.key.startsWith('line.'));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.deepEqual(rows.map(row => row.key).sort(),
    Object.keys(LINE_SETTING_DEFINITIONS).map(key => `line.${key}`).sort());
  for (const row of rows) assert.equal(row.value, row.key === 'line.wipPerReviewer' ? 2 : false,
    `${row.key} exposes its configured value or default`);
  assert.deepEqual(rows.find(row => row.key === 'line.wipPerReviewer'), { key: 'line.wipPerReviewer', scope: 'board',
    board: store.boardId(board), root: box.repo, value: 2, default: false,
    source: join(box.repo, '.git', 'pullboard', 'board.sqlite'), origin: 'configured' });
  assert.equal(rows.find(row => row.key === 'line.focusMilestone').value, false);
  assert.equal(rows.find(row => row.key === 'line.reviewsFirst').value, false);
  assert.equal(rows.find(row => row.key === 'line.bar.check').value, false);
  assert.equal(rows.find(row => row.key === 'line.reviewsFirst').origin, 'default');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_REASON_CANARY|activeReviewers|reviewMedianMinutes/u);
  assert.equal(store.events(board).length, before, 'inventory is a read, not a line-setting change');
});

test('collision-free batch policy stays off until a current authenticated coordinator records it [R1,R2,H16]', t => {
  const board = fixture(t);
  assert.equal(store.lineSettings(board).collisionFreeBatch, false);
  const options = change({ key: 'collisionFreeBatch' });
  const move = prepareEngineMove(board, 'setLineSetting', [options], { id: 'collision-policy', actor: 'coordinator' });
  const envelope = { sequence: 1, at: '2026-10-24T00:00:00Z', kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture' } };
  assert.throws(() => applyRelayMove(board, { ...move, engine: LAND_COLLISION_ENGINE - 1 }, envelope), /RELAY_MOVE/u);
  assert.equal(store.lineSettings(board).collisionFreeBatch, false);
  assert.equal(applyRelayMove(board, move, envelope).error, undefined);
  assert.equal(store.lineSettings(board).collisionFreeBatch, true);
  assert.throws(() => store.setLineSetting(board, change({ key: 'collisionFreeBatch', value: 1 })), /LINE_SETTING_RANGE/u);
  store.setLineSetting(board, change({ key: 'collisionFreeBatch', value: false }));
  assert.equal(store.lineSettings(board).collisionFreeBatch, false);
});

test('[R2,H16] bar.check setting moves require the new engine and current clients still apply them', t => {
  const board = fixture(t);
  const options = change({ key: 'bar.check' });
  const move = prepareEngineMove(board, 'setLineSetting', [options], { id: 'bar-check-policy', actor: 'coordinator' });
  assert.ok(move.engine >= BAR_CHECK_ENGINE, 'the new line-setting key carries at least its engine floor');
  const envelope = { sequence: 1, at: '2026-10-24T00:00:00Z', kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture' } };
  assert.throws(() => applyRelayMove(board, { ...move, engine: BAR_CHECK_ENGINE - 1 }, envelope), /RELAY_MOVE.*introduced in engine/u);
  assert.equal(store.lineSettings(board)['bar.check'], false, 'an old-engine move cannot enable the setting');
  const applied = applyRelayMove(board, move, envelope);
  assert.equal(applied.error, undefined);
  assert.equal(store.lineSettings(board)['bar.check'], true, 'the current engine applies the same recorded move');
});
