/** Local heartbeat and foreign shared fencing use independent physical SQLite replicas [Q1,Q3,H16,E19]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { restoreRelaySnapshot } from '../../../../packages/store/index.js';
import { semanticBoardDigest } from '../../../../packages/store/index.js';
import { assertLandingLease } from '../../../../packages/store/index.js';
import { LANDING_LOCAL_PREFIX } from '../../../../packages/store/index.js';
import { localLandingEntry } from '../../../../packages/store/index.js';
import { takeLandingResource } from '../../../../packages/landing/index.js';
import { LANDING_LEASE_ENGINE } from '../../../../packages/state/light.js';

/** Give each test two physical boards and a private receipt clock, never a live coordinator credential. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-local-heartbeat-'));
  let at = Date.parse('2026-01-01T00:00:00Z');
  const boards = [0, 1].map(index => openBoard(':memory:', { now: () => new Date(at) }));
  store.register(boards[0], { lane: 'coordinator', path: dir });
  let sequence = 0;
  /** Apply a real ordered private engine receipt with the declared coordinator machine. */
  const move = (board, operation, args, lineage = 'private-lineage-a', machine = 'private-machine-a') => {
    const prepared = { ...prepareEngineMove(board, operation, args), holder: machine };
    const result = applyEngineMove(board, prepared, { sequence: ++sequence, at: new Date(at).toISOString(), standing: { root: true, lineage } });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result;
  };
  t.after(() => { for (const board of boards) store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  return { boards, move, advance(ms) { at += ms; } };
}

/** Drain promise continuations after advancing only this test's heartbeat intervals. */
async function settle() { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }

test('lib.landing-lease.a-relay-stalled-for-120-seconds: a relay stalled for 120 seconds cannot block the holder local landing heartbeat [Q1,Q3,H16]', async t => {
  const box = fixture(t); const [board, replica] = box.boards;
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const actions = [];
  const lease = await takeLandingResource({ board, branch: 'refs/heads/main',
    write: async (operation, args) => {
      actions.push(args[0].action);
      if (args[0].action === 'renew') return new Promise(() => {}); // stand-in relay never acknowledges renewal.
      return box.move(board, operation, args);
    } });
  try {
    const shared = exportBoard(board);
    const digest = semanticBoardDigest(shared);
    for (let step = 0; step < 24; step += 1) {
      box.advance(5000); t.mock.timers.tick(5000); await settle();
    }
    await lease.assertHeld();
    assert.deepEqual(actions, ['request'], '120 seconds of heartbeats never invoked the stalled relay writer');
    assert.equal(semanticBoardDigest(exportBoard(board)), digest, 'local deadlines do not change shared semantic state');
    assert.ok(Date.parse(lease.assertCurrent().until) > board.clock.now().getTime());
    assert.equal(shared.tables.board_meta.some(row => row.meta_key.startsWith(LANDING_LOCAL_PREFIX)), false);
    importBoard(replica, shared);
    assert.equal(replica.db.prepare('SELECT count(*) AS n FROM board_meta WHERE meta_key GLOB ?').get(LANDING_LOCAL_PREFIX + '*').n, 0);
    restoreRelaySnapshot(board, shared, 1, digest);
    assertLandingLease(board, lease.fence); // checkpoint replacement retains only this physical board's local heartbeat.
    const foreign = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
    assert.equal(store.landingLeaseMove(replica, foreign).acquired, false, 'a replica cannot grant past unseen local renewals using its expired shared clock');
    store.landingLeaseMove(replica, { agentId: 'coordinator', action: 'release', ...lease.fence });
    assert.equal(store.landingLeaseMove(replica, foreign).acquired, true, 'explicit release admits the foreign waiter');
  } finally { await lease.release(); }
});

test('lib.landing-lease.coordinator-takeover-fences-an-unreleased-foreign: coordinator takeover fences an unreleased foreign landing without inventing a new expiry [Q1,Q3,E19]', t => {
  const box = fixture(t); const [board, replica] = box.boards;
  const first = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
  const grant = box.move(board, 'landingLeaseMove', [first]);
  importBoard(replica, exportBoard(board));
  box.advance(120_000);
  const second = { ...first, token: randomUUID() };
  assert.equal(store.landingLeaseMove(replica, second).acquired, false);
  box.move(replica, 'takeCoordinator', [{ agentId: 'coordinator', machine: 'private-machine-b' }], 'private-lineage-b', 'private-machine-b');
  assert.throws(() => assertLandingLease(replica, { ...first, generation: grant.generation }), error => error.code === 'LAND_LEASE_LOST');
  const successor = box.move(replica, 'landingLeaseMove', [second], 'private-lineage-b', 'private-machine-b');
  assert.equal(successor.acquired, true);
  assert.ok(successor.generation > grant.generation);
});


test('lib.landing-lease.physical-heartbeat-identity-cannot-attach-to: physical heartbeat identity cannot attach to another board or arrive in an import [Q1,Q3,H16]', async t => {
  const box = fixture(t); const [board, replica] = box.boards;
  const lease = await takeLandingResource({ board, branch: 'refs/heads/main', write: async (operation, args) => box.move(board, operation, args) });
  try {
    const holder = store.landingLeaseState(board).holder;
    const row = board.db.prepare('SELECT * FROM board_meta WHERE meta_key=?').get(LANDING_LOCAL_PREFIX + holder.token);
    const document = exportBoard(board);
    document.tables.board_meta.push(row); // imported local metadata is deliberately untrusted, even with an exact token.
    importBoard(replica, document);
    assert.equal(localLandingEntry(replica, holder), null);
    const old = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
    board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='board_id'").run('different-private-board');
    assert.equal(localLandingEntry(board, holder), null, 'board identity participates in the local token/generation binding');
    board.db.prepare("UPDATE board_meta SET meta_value=? WHERE meta_key='board_id'").run(old);
  } finally { await lease.release(); }
});


test('lib.landing-lease.historical-landing-lease-receipts-retain-their: historical landing lease receipts retain their original renewal events [Q1,H16]', t => {
  const box = fixture(t); const [board] = box.boards;
  const request = { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
  let sequence = 0;
  /** Replay the old sealed protocol rather than silently rewriting historical event meaning. */
  const oldMove = args => {
    const move = { ...prepareEngineMove(board, 'landingLeaseMove', [args]), engine: LANDING_LEASE_ENGINE };
    const outcome = applyEngineMove(board, move, { sequence: ++sequence, at: board.clock.now().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    return outcome.result;
  };
  const grant = oldMove(request);
  box.advance(1000);
  oldMove({ ...request, action: 'renew', generation: grant.generation });
  assert.equal(board.db.prepare("SELECT count(*) AS n FROM event WHERE event_kind='landing_lease'").get().n, 2);
});
