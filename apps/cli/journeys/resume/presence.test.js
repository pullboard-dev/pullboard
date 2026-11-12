/** Seat identity survives heartbeat-based presence changes on a real SQLite board [B3]. */
import {
  openBoard,
} from '../../../lib/index.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  fixtureBoard,
} from '../../tests/fixtures/board.js';
import {
  writeFileSync,
} from 'node:fs';
import {
  DatabaseSync,
} from 'node:sqlite';
import {
  runCliInProcess,
} from '../../tests/fixtures/process.js';
import {
  fixtureAdd,
} from '../../tests/fixtures/testkit.js';

test('a locked presence sidecar retains cached timestamps and next reports its bounded fallback [B3,N2,C7]', async t => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { importSeatObservations, withLocalSeatPresence } = await import('../../../../packages/store/index.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Presence lock control', '--criterion', 'Offer real work despite a busy display cache', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const observedAt = Date.now();
  let at = observedAt - 2_400_000;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: both connections belong to this private native fixture.
  const board = openBoard(file, { now: () => new Date(at) });
  const imported = store.register(board, { lane: 'web', path: join(box.dir, 'display-only') });
  at = observedAt;
  const local = store.agentById(board, 'web-1');
  importSeatObservations(board, [{ agent_id: imported, heartbeatAt: new Date(at).toISOString() }]);
  const display = store.agentById(board, imported);
  const writer = new DatabaseSync(`${file}.presence.sqlite`);
  t.after(() => { writer.close(); store.closeBoard(board); });
  writer.exec('BEGIN EXCLUSIVE');
  try {
    at += 600_000;
    const cached = store.agentById(board, 'web-1');
    assert.equal(cached.heartbeatAt, local.heartbeatAt, 'contention cannot fabricate a new heartbeat');
    assert.equal(cached.presence, 'idle', 'cached timestamps still age across the real boundary');
    assert.equal(store.agentById(board, imported).heartbeatAt, display.heartbeatAt);
    assert.equal(withLocalSeatPresence(board, [{ agent_id: imported }])[0].presence, 'gone', 'imported display activity never becomes local authority');
    const started = Date.now();
    const next = box.run(box.web, 'next', '--build', '--json');
    assert.equal(next.code, 0, next.err + next.out);
    assert.equal(JSON.parse(next.out).item.item_id, item, 'actual next reaches its native work result');
    assert.match(next.err, /PRESENCE_BUSY.*presence sidecar remained locked/su);
    assert.ok(Date.now() - started < 15_000, 'the busy sidecar cannot hang next'); // budget: generous private CLI hang ceiling, not a latency target.
  } finally { writer.exec('ROLLBACK'); }
  assert.equal(store.agentById(board, 'web-1').heartbeatAt, local.heartbeatAt, 'fallback never persisted its cached projection');
});

test('presence fallback does not hide a corrupt private sidecar [B3,C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-corrupt-'));
  // @pullboard-board-file persistence: only this disposable board and its own sidecar are changed.
  const board = openBoard(join(root, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  const id = store.register(board, { lane: 'core', path: join(root, 'seat') });
  assert.equal(store.agentById(board, id).presence, 'live');
  writeFileSync(join(root, 'board.sqlite.presence.sqlite'), 'not a SQLite database');
  assert.throws(() => store.agentById(board, id), error => error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) !== 5,
    'only genuine lock contention may use the cached snapshot');
});

test('next and status count only live seats as capacity [B3,N2,C7]', async t => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { importSeatObservations } = await import('../../../../packages/store/index.js');
  const { dispatchWork } = await import('../../../../packages/store/index.js');
  const { dispatchHealth } = await import('../../../../packages/sentinels/index.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const now = Date.now();
  let at = now - 2_400_000;
  // @pullboard-board-file journey: production status opens this private native board and presence sidecar.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  const gone = store.register(board, { lane: 'web', path: join(box.dir, 'gone-seat') });
  const remote = store.register(board, { lane: 'web', path: join(box.dir, 'display-only-seat') });
  at = now - 1_200_000;
  const idle = store.register(board, { lane: 'web', path: join(box.dir, 'idle-seat') });
  at = now;
  importSeatObservations(board, [{ agent_id: remote, heartbeatAt: new Date(now).toISOString() }]);
  assert.equal(store.agentById(board, remote).presence, 'live', 'the relay display control really appears live');
  assert.equal(store.agentById(board, idle).presence, 'idle');
  assert.equal(store.agentById(board, gone).presence, 'gone');
  const ready = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private live route control',
    criterion: 'Only a locally live seat receives the offer', check: 'true' });
  store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Private blocked route control',
    criterion: 'Wait for the ready control', check: 'true', after: [ready] });
  for (const agentId of ['web-1', idle, gone, remote]) {
    assert.equal(store.nextFor(board, { agentId, lane: 'web' }).item.item_id, ready,
      'the absent live-only setting preserves ordinary routing');
  }
  store.setLineSetting(board, { agentId: 'coordinator', key: 'route.liveOnly', value: true,
    reason: 'Only authenticated local activity supplies routing capacity', window: { windowMinutes: 60, registeredSeats: 5 } });
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, ready);
  for (const agentId of [idle, gone, remote]) {
    assert.equal(store.nextFor(board, { agentId, lane: 'web' }).item, null,
      'idle, gone and imported-display-only seats receive no new routed item');
    assert.equal(dispatchWork(board, store.agentById(board, agentId)).item, null,
      'the automatic dispatcher applies the same local-only advice');
  }
  const before = store.events(board);
  const status = await runCliInProcess(['status', '--json'], { cwd: box.repo, env: box.env });
  assert.equal(status.status, 0, status.stderr);
  const summary = JSON.parse(status.stdout);
  assert.deepEqual(summary.capacity, { liveOnly: true, liveAgents: 1, idleAgents: 1, readyItems: 1 },
    'capacity excludes the coordinator, stale seats and display-only imports; dependencies stay blocked');
  const text = await runCliInProcess(['status'], { cwd: box.repo, env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /capacity: 1 live, 1 idle, 1 ready item/u);
  assert.deepEqual(store.events(board), before, 'status and routing advice write no native history');
  at = now + 360_000;
  importSeatObservations(board, [{ agent_id: 'web-1', heartbeatAt: new Date(at).toISOString() }]);
  assert.ok(dispatchHealth(board).findings.some(finding => finding.cause === 'UNPAIRED_WORK' && finding.item === ready),
    'a newer imported display timestamp cannot postpone the live local seat dispatch warning');
  assert.deepEqual(store.events(board), before, 'dispatch health remains advice, not a native mutation');
  store.setLineSetting(board, { agentId: 'coordinator', key: 'route.liveOnly', value: false,
    reason: 'Restore ordinary routing', window: { liveAgents: 1 } });
  assert.equal(store.nextFor(board, { agentId: gone, lane: 'web' }).item.item_id, ready);
});

test('live-only advice never changes authenticated setting or claim replay [B3,N2,H16]', async t => {
  const { fixtureBoard } = await import('../../tests/fixtures/board.js');
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const { applyEngineMove, prepareEngineMove, appliedSequence } = await import('../../../../packages/state/index.js');
  const { LIVE_ROUTE_ENGINE } = await import('../../../../packages/state/light.js');
  const at = new Date().toISOString();
  const clock = { now: () => new Date(at) };
  const source = fixtureBoard(t, { clock });
  const replica = fixtureBoard(t, { clock });
  store.register(source, { lane: 'coordinator', path: '/private/live-route' });
  const seat = store.register(source, { lane: 'web', path: '/private/live-route/web' });
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Private replay control', check: 'true' });
  importBoard(replica, exportBoard(source));
  const setting = prepareEngineMove(source, 'setLineSetting', [{ agentId: 'coordinator', key: 'route.liveOnly',
    value: true, reason: 'Private local-activity routing control', window: { registeredSeats: 2 } }], { id: 'live-route-setting' });
  const envelope = { sequence: appliedSequence(source) + 1, at };
  const before = exportBoard(replica);
  assert.throws(() => applyEngineMove(replica, { ...setting, engine: LIVE_ROUTE_ENGINE - 1 }, envelope),
    error => error.code === 'RELAY_MOVE', 'an old setting move cannot silently enable the new policy');
  assert.deepEqual(exportBoard(replica), before);
  const settingResult = applyEngineMove(source, setting, envelope);
  assert.equal(settingResult.error, undefined);
  assert.deepEqual(applyEngineMove(replica, setting, envelope), settingResult);
  assert.equal(store.nextFor(source, { agentId: seat, lane: 'web' }).item.item_id, id);
  assert.equal(store.nextFor(replica, { agentId: seat, lane: 'web' }).item, null,
    'the replica imported no local activity and offers no new work');
  const claim = prepareEngineMove(source, 'claim', [id, { agentId: seat, lane: 'web', leaseMs: 60_000,
    head: 'a'.repeat(40), freeze: () => ({ text: 'Private replay fixture criterion', digest: 'f'.repeat(64) }) }],
  { id: 'live-route-native-claim' });
  const claimEnvelope = { sequence: appliedSequence(source) + 1, at };
  const result = applyEngineMove(source, claim, claimEnvelope);
  assert.equal(result.error, undefined);
  assert.equal(result.events[0].event_kind, 'claim');
  assert.deepEqual(applyEngineMove(replica, claim, claimEnvelope), result,
    'native claim replay depends on its sealed authority, not a replica heartbeat');
  assert.deepEqual(exportBoard(replica), exportBoard(source));
  assert.deepEqual(applyEngineMove(replica, claim, claimEnvelope), result, 'duplicate delivery stays idempotent');
  assert.equal(store.nextFor(replica, { agentId: seat, lane: 'web' }).item.item_status, 'claimed',
    'a non-live seat can still see work it already holds');
});

test('a seat presence moves live to idle to gone from its heartbeat [B3]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-'));
  let at = Date.parse('2026-10-24T12:00:00Z');
  const board = openBoard(join(root, 'board.sqlite'), { now: () => new Date(at) });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  const id = store.register(board, { lane: 'core', path: join(root, 'seat') });
  const identity = store.agentById(board, id);
  assert.equal(store.listAgents(board).find(seat => seat.agent_id === id).presence, 'live');
  at += 10 * 60_000 - 1;
  assert.equal(store.listAgents(board).find(seat => seat.agent_id === id).presence, 'live');
  at += 1;
  assert.equal(store.listAgents(board).find(seat => seat.agent_id === id).presence, 'idle');
  at += 20 * 60_000;
  assert.equal(store.listAgents(board).find(seat => seat.agent_id === id).presence, 'gone');
  assert.equal(store.agentById(board, id).agent_id, identity.agent_id);
  assert.equal(store.agentById(board, id).agent_path, identity.agent_path);
});
