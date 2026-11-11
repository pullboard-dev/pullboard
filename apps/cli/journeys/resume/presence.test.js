import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../lib/index.js';
/** Seat identity survives heartbeat-based presence changes on a real SQLite board [B3]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixture as dispatchFixture } from '../../tests/fixtures/next/take.js';
import { cli as dispatchCli } from '../../tests/fixtures/next/take.js';

test('ready work waiting past the limit while agents are idle warns the coordinator once [B3,N2,C7]', async t => {
  const box = await dispatchFixture(t);
  const ready = box.add('Ready idle-seat work');
  const blocked = box.add('Dependent work', { after: [ready] });
  const future = box.add('Future milestone work');
  store.addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange dispatch fixture', name: 'Current', items: [ready, blocked] });
  store.addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange dispatch fixture', name: 'Later', items: [future] });
  const warnings = () => store.allShouts(box.board).filter(row => row.shout_to === 'coordinator' && row.shout_text.startsWith('Stuck:') && row.shout_text.includes('UNPAIRED_WORK'));
  box.scan();
  box.advance(299999);
  store.heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 0);
  box.advance(1);
  box.scan();
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].shout_text, new RegExp(`${box.seats.actor.id}.*#${ready}.*5 min`, 'u'));
  box.scan();
  assert.equal(warnings().length, 1, 'the same idle spell is reported once');
  const selected = await dispatchCli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(selected.code, 0, selected.out + selected.err);
  assert.equal(selected.document.item.item_id, ready);
  box.scan();
  box.advance(300000);
  store.heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1, 'dependent and future work do not count as ready');
});

test('changing the eligible item does not repeat an idle-seat warning until a claim [B3,N2,C7]', async t => {
  const box = await dispatchFixture(t);
  const first = box.add('First eligible item');
  const warnings = () => store.allShouts(box.board).filter(row => row.shout_to === 'coordinator'
    && row.shout_text.startsWith(`Stuck: ${box.seats.actor.id} beside #`) && row.shout_text.includes('UNPAIRED_WORK'));
  box.scan();
  box.advance(300000);
  store.heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].shout_text, new RegExp(`#${first}\\b`, 'u'));
  const second = box.add('Replacement eligible item');
  store.holdItem(box.board, first, { agentId: 'coordinator', reason: 'The first fixture item is held' });
  box.scan();
  box.advance(300000);
  store.heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1, 'changing next selection does not create another warning in the same idle spell');
  const claimed = await dispatchCli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  assert.equal(claimed.document.item.item_id, second);
  store.release(box.board, second, box.seats.actor.id, 'Reopen the private fixture item', 'OTHER');
  box.scan();
  box.advance(300000);
  store.heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 2, 'a claim starts a new idle spell');
  assert.match(warnings()[1].shout_text, new RegExp(`#${second}\\b`, 'u'));
});

test('work becoming ready beside an already idle seat warns without another five-minute wait [B3,N2,C7]', async t => {
  const box = await dispatchFixture(t);
  box.advance(300001);
  store.heartbeatSeat(box.board, box.seats.actor.id);
  const ready = box.add('Work becomes ready after the idle limit');
  box.scan();
  const warnings = store.allShouts(box.board).filter(row => row.shout_to === 'coordinator'
    && row.shout_text.startsWith(`Stuck: ${box.seats.actor.id} beside #${ready} `)
    && row.shout_text.includes('UNPAIRED_WORK'));
  assert.equal(warnings.length, 1, 'a seat already idle past the limit is reported when work becomes ready');
});

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

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

test('local heartbeats revive a seat without changing exported history or a remote copy [B3,A7]', async (t) => {
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-local-'));
  let at = Date.parse('2026-10-24T12:00:00Z');
  const clock = { now: () => new Date(at) };
  const board = openBoard(join(root, 'board.sqlite'), clock);
  const remote = openBoard(join(root, 'remote.sqlite'), clock);
  t.after(() => { store.closeBoard(board); store.closeBoard(remote); rmSync(root, { recursive: true, force: true }); });
  const id = store.register(board, { lane: 'core', path: join(root, 'seat') });
  const before = exportBoard(board);
  at += 30 * 60_000;
  assert.equal(store.agentById(board, id).presence, 'gone');
  assert.equal(heartbeatSeat(board, id), true);
  assert.equal(store.agentById(board, id).presence, 'live');
  assert.equal(store.agentById(board, id).heartbeatAt, clock.now().toISOString());
  assert.deepEqual(exportBoard(board), before, 'heartbeat is not native history or exported state');
  importBoard(remote, before);
  assert.equal(store.agentById(remote, id).presence, 'gone', 'a foreign registration is not a local heartbeat');
  assert.equal(store.agentById(remote, id).heartbeatAt, null);
  assert.equal(heartbeatSeat(board, 'missing-seat'), false);
});

test('a relay reader sees the same presence as the native view [B3,I6,H5,H17]', async (t) => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { relaySnapshot } = await import('../../../../packages/pages/index.js');
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  let at = Date.now();
  const clock = { now: () => new Date(at) };
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
  const remote = openBoard(join(box.dir, 'relay-reader.sqlite'), clock);
  t.after(() => { store.closeBoard(board); store.closeBoard(remote); });
  const id = store.register(board, { lane: 'core', path: join(box.dir, 'presence-seat') });
  const history = exportBoard(board);
  const snapshot = relaySnapshot(box.repo, { board }, RELAY_PRESENTATION_PORTS);
  const nativeAgents = snapshot.presentation.state.agents;
  assert.equal(nativeAgents.find(seat => seat.agent_id === id).presence, 'live', 'the native snapshot includes an observed live seat');
  importBoard(remote, snapshot);
  const restored = relaySnapshot(box.repo, { board: remote }, RELAY_PRESENTATION_PORTS);
  assert.deepEqual(restored.presentation.state.agents, nativeAgents, 'restoring and republishing a relay snapshot preserves every projected agent');
  assert.deepEqual(exportBoard(board), history, 'snapshot capture leaves native history unchanged');
  assert.deepEqual(exportBoard(remote), history, 'relay observations remain outside native exports');
  at += 10 * 60_000;
  assert.equal(relaySnapshot(box.repo, { board: remote }, RELAY_PRESENTATION_PORTS).presentation.state.agents.find(seat => seat.agent_id === id).presence, 'idle');
  at += 20 * 60_000;
  assert.equal(relaySnapshot(box.repo, { board: remote }, RELAY_PRESENTATION_PORTS).presentation.state.agents.find(seat => seat.agent_id === id).presence, 'gone');
  assert.equal(heartbeatSeat(remote, id), true, 'a real local heartbeat can independently refresh the reader');
  assert.equal(store.agentById(remote, id).presence, 'live');
});

test('status reads and explicit hooks heartbeat without a shared board write [B3,I6]', async (t) => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { projectState } = await import('../../src/io/view.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const local = new DatabaseSync(`${file}.presence.sqlite`);
  t.after(() => local.close());
  const boardId = local.prepare("ATTACH DATABASE ? AS native");
  boardId.run(file);
  const identity = local.prepare("SELECT meta_value FROM native.board_meta WHERE meta_key='board_id'").get().meta_value;
  local.exec('DETACH DATABASE native');
  local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run('2000-01-01T00:00:00.000Z', JSON.stringify([identity, 'web-1']));
  local.exec('CREATE TABLE writes(n INTEGER NOT NULL); INSERT INTO writes VALUES(0); CREATE TRIGGER count_heartbeat AFTER UPDATE ON heartbeat BEGIN UPDATE writes SET n=n+1; END');
  const board = openBoard(file);
  const events = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  board.db.exec('BEGIN IMMEDIATE');
  const status = box.run(box.web, 'status', '--json');
  const explicit = box.run(box.web, 'heartbeat', '--json');
  board.db.exec('ROLLBACK');
  assert.equal(status.code, 0, status.err + status.out);
  const summary = JSON.parse(status.out);
  assert.equal(summary.agents.find(seat => seat.agent_id === 'web-1').presence, 'gone', 'status reads the stale observation');
  assert.equal(explicit.code, 0, explicit.err + explicit.out);
  assert.equal(JSON.parse(explicit.out).presence, 'live');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'the explicit hook alone refreshes while the shared board is write-locked');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, events);
  const state = projectState(box.repo, { board });
  assert.equal(state.agents.find(seat => seat.agent_id === 'web-1').presence, 'live');
  store.closeBoard(board);
  const settings = JSON.parse(readFileSync(join(box.repo, '.claude', 'settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
    const commands = settings.hooks[event].flatMap(entry => entry.hooks.map(hook => hook.command));
    assert.ok(commands.some(command => command.includes(`hook ${event}`)), event);
  }
  const heartbeat = box.run(box.web, 'heartbeat', '--json');
  assert.equal(heartbeat.code, 0, heartbeat.err + heartbeat.out);
  assert.equal(JSON.parse(heartbeat.out).presence, 'live');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'a separate CLI process in the same minute performs no additional heartbeat write');
});


test('an imported board never inherits a same-path coordinator heartbeat [B3,A7]', async (t) => {
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-identity-'));
  const clock = { now: () => new Date('2026-10-24T12:00:00Z') };
  const local = openBoard(join(root, 'local.sqlite'), clock);
  const foreign = openBoard(join(root, 'foreign.sqlite'), clock);
  t.after(() => { store.closeBoard(local); store.closeBoard(foreign); rmSync(root, { recursive: true, force: true }); });
  store.register(local, { lane: 'coordinator', path: join(root, 'old-coordinator') });
  store.register(foreign, { lane: 'coordinator', path: join(root, 'foreign-coordinator') });
  /** Read the native board identity to prove this is a real replacement. */
  const identity = board => board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  assert.notEqual(identity(local), identity(foreign));
  assert.equal(store.agentById(local, 'coordinator').presence, 'live');
  importBoard(local, exportBoard(foreign));
  assert.equal(identity(local), identity(foreign), 'the accepted import really replaced board identity');
  assert.equal(store.agentById(local, 'coordinator').agent_path, join(root, 'foreign-coordinator'));
  assert.equal(store.agentById(local, 'coordinator').presence, 'gone');
  assert.equal(store.agentById(local, 'coordinator').heartbeatAt, null);
});

test('plain status counts large seat history and hides gone seats behind --all [B3,C7]', async (t) => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const { JSON_SHAPES } = await import('../../../../packages/config/index.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  let at = Date.now() - 40 * 60_000;
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
  const gone = [];
  for (let index = 0; index < 100; index += 1) gone.push(store.register(board, { lane: 'api', path: join(box.dir, `history-${index}`) }));
  at = Date.now() - 11 * 60_000;
  const idle = store.register(board, { lane: 'api', path: join(box.dir, 'idle-seat') });
  at = Date.now();
  heartbeatSeat(board, 'coordinator');
  heartbeatSeat(board, 'web-1');
  assert.equal(store.listAgents(board).filter(seat => seat.presence === 'gone').length, 100);
  store.closeBoard(board);
  const plain = box.run(box.web, 'status');
  assert.equal(plain.code, 0, plain.err + plain.out);
  assert.match(plain.out, /seats: 2 live, 1 idle, 100 gone/u);
  assert.ok(plain.out.includes(`${idle}: idle`));
  assert.ok(gone.every(id => !plain.out.includes(`${id}: gone`)), 'plain status never prints historical gone rows');
  const all = box.run(box.web, 'status', '--all');
  assert.equal(all.code, 0, all.err + all.out);
  assert.ok(gone.every(id => all.out.includes(`${id}: gone`)), 'the explicit flag retains access to every identity');
  const structured = box.run(box.web, 'status', '--json');
  assert.equal(structured.code, 0, structured.err + structured.out);
  const summary = JSON.parse(structured.out);
  assert.deepEqual(summary.presenceCounts, { live: 2, idle: 1, gone: 100 });
  assert.equal(summary.agents.length, 103, 'JSON may retain full history per outside1705');
  assert.equal(JSON_SHAPES.commands.heartbeat.required.seat, 'string|null');
  assert.equal(JSON_SHAPES.commands.heartbeat.required.heartbeatAt, 'string|null');
});


test('a local heartbeat persists once per minute and refreshes after clock rollback [B3,C7]', async (t) => {
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const { DatabaseSync } = await import('node:sqlite');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-throttle-'));
  let at = Date.parse('2026-10-24T12:00:00.000Z');
  const file = join(root, 'board.sqlite');
  const board = openBoard(file, { now: () => new Date(at) });
  const id = store.register(board, { lane: 'core', path: join(root, 'seat') });
  const local = new DatabaseSync(`${file}.presence.sqlite`);
  t.after(() => { local.close(); store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  local.exec('CREATE TABLE writes(n INTEGER NOT NULL); INSERT INTO writes VALUES(0); CREATE TRIGGER count_update AFTER UPDATE ON heartbeat BEGIN UPDATE writes SET n=n+1; END');
  const first = store.agentById(board, id).heartbeatAt;
  at += 59_999;
  assert.equal(heartbeatSeat(board, id), true);
  assert.equal(store.agentById(board, id).heartbeatAt, first);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'fresh activity needs no SQLite update');
  at += 1;
  assert.equal(heartbeatSeat(board, id), true);
  assert.equal(store.agentById(board, id).heartbeatAt, new Date(at).toISOString());
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'the exact one-minute boundary refreshes once');
  at -= 120_000;
  assert.equal(heartbeatSeat(board, id), true);
  assert.equal(store.agentById(board, id).heartbeatAt, new Date(at).toISOString(), 'a future persisted value cannot suppress observations after rollback');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 2);
  assert.equal(heartbeatSeat(board, id), true);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 2, 'the rollback replacement is itself throttled');
});


test('read commands never refresh presence while committed writes and hooks do [B3,C7]', async (t) => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { DatabaseSync } = await import('node:sqlite');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const { runCliInProcess } = await import('../../tests/fixtures/process.js');
  /** Reuse production parsing/dispatch with the same private identity and captured streams. */
  box.run = (cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
  // Complete the genuine baseline before measuring hooks, rather than racing its background event.
  const added = await fixtureAdd(box.run, box.repo, 'web', 'Read-only presence control', '--criterion', 'Keep the same item', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const withdrawn = await box.run(box.repo, 'withdraw', String(id), 'Private read-only presence control', '--json');
  assert.equal(withdrawn.code, 0, withdrawn.err + withdrawn.out);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(file);
  const local = new DatabaseSync(`${file}.presence.sqlite`);
  t.after(() => { local.close(); store.closeBoard(board); });
  assert.equal(store.getItem(board, id).item_status, 'withdrawn', 'the real native move leaves no claimable item');
  const identity = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const key = JSON.stringify([identity, 'web-1']);
  const stale = '2000-01-01T00:00:00.000Z';
  local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(stale, key);
  local.exec('CREATE TABLE writes(n INTEGER NOT NULL); INSERT INTO writes VALUES(0); CREATE TRIGGER count_update AFTER UPDATE ON heartbeat BEGIN UPDATE writes SET n=n+1; END');
  board.db.exec('BEGIN IMMEDIATE');
  try {
    const status = await box.run(box.web, 'status', '--json');
    assert.equal(status.code, 0, status.err + status.out);
    const summary = JSON.parse(status.out);
    assert.equal(summary.agents.find(seat => seat.agent_id === 'web-1').presence, 'gone', 'status projects the stored observation without reviving it');
    assert.equal(local.prepare('SELECT at FROM heartbeat WHERE seat=?').get(key).at, stale);
    for (const args of [['show', String(id), '--json'], ['list', '--json']]) {
      const result = await box.run(box.web, ...args);
      assert.equal(result.code, 0, result.err + result.out);
      assert.equal(JSON.parse(result.out).version, 1);
    }
    const next = await box.run(box.web, 'next', '--json');
    assert.ok([0, 1].includes(next.code), next.err + next.out);
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_status='claimed'").get().n, 0, 'the next control really makes no claim');
    assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'none of the read commands writes the private sidecar');
  } finally { board.db.exec('ROLLBACK'); }
  const shouted = await box.run(box.web, 'shout', 'all', 'Committed write refreshes this seat', '--json');
  assert.equal(shouted.code, 0, shouted.err + shouted.out);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1);
  const shout = board.db.prepare('SELECT shout_at FROM shout WHERE shout_from=? ORDER BY shout_id DESC LIMIT 1').get('web-1');
  const observed = local.prepare('SELECT at FROM heartbeat WHERE seat=?').get(key).at;
  assert.ok(Date.parse(observed) >= Date.parse(shout.shout_at), 'the local refresh follows the committed native shout');
  local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(stale, key);
  local.exec('UPDATE writes SET n=0');
  const refused = await box.run(box.web, 'shout', 'missing-reader', 'This write must refuse', '--json');
  assert.equal(refused.code, 1, refused.err + refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_READER');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'a refused native write cannot refresh presence');
  const events = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const hook = await box.run(box.web, 'heartbeat', '--json');
  assert.equal(hook.code, 0, hook.err + hook.out);
  assert.equal(JSON.parse(hook.out).presence, 'live');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'an explicit agent hook still refreshes the stale private observation');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, events, 'the hook remains local, not an ordered move');
  local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(stale, key);
  local.exec('UPDATE writes SET n=0');
  const resumed = await box.run(box.web, 'resume', '--json');
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'public resume is not an activity hook');
  const { readFileSync } = await import('node:fs');
  const { runFixtureChild } = await import('../../tests/fixtures/child.js');
  const settings = JSON.parse(readFileSync(join(box.web, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.ok(command.includes('hook SessionStart'));
  const session = runFixtureChild('sh', ['-c', command], { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(session.status, 0, session.failure || session.stderr || session.stdout);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'SessionStart explicitly observes activity before its read-only resume');
  for (const event of ['Stop', 'SessionEnd']) {
    local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(stale, key);
    local.exec('UPDATE writes SET n=0');
    const command = settings.hooks[event].at(-1).hooks[0].command;
    const observed = runFixtureChild('sh', ['-c', command], { cwd: box.web, env: box.env, encoding: 'utf8' });
    assert.equal(observed.status, 0, observed.failure || observed.stderr || observed.stdout);
    assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, `${event} records actual local activity`);
    if (board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n !== events) {
      t.diagnostic(JSON.stringify({ hook: event, sharedEvents: board.db.prepare('SELECT event_id,event_kind,event_by,event_detail FROM event ORDER BY event_id').all() }));
    }
    assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, events, `${event} never writes shared history`);
  }
});


test('checkpoint fingerprints retain hidden-seat heartbeats without treating clock movement as a write [B3,H16]', async t => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const { exportBoard } = await import('../../../../packages/store/index.js');
  const { relayPresentation, presentationDigest } = await import('../../../../packages/pages/index.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  let at = Date.now();
  // @pullboard-board-file journey: real checkpoint inputs include this private board's presence sidecar.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  heartbeatSeat(board, 'coordinator');
  const before = relayPresentation(box.repo, { board, observedAt: at }, RELAY_PRESENTATION_PORTS);
  const heartbeat = store.agentById(board, 'coordinator').heartbeatAt;
  const history = exportBoard(board);
  const laterAt = at + 5 * 3_600_000; // budget: fixture clock crosses the four-hour activity window; no elapsed-time performance assertion.
  const later = relayPresentation(box.repo, { board, observedAt: laterAt }, RELAY_PRESENTATION_PORTS);
  assert.ok(before.state.agents.some(seat => seat.agent_id === 'coordinator'), 'the native seat is initially visible');
  assert.ok(!later.state.agents.some(seat => seat.agent_id === 'coordinator'), 'the unchanged seat leaves the activity window');
  assert.notEqual(before.state.observedAt, later.state.observedAt);
  assert.equal(presentationDigest(later), presentationDigest(before), 'clock-only visibility and presence changes do not publish');
  at += 60_000; // budget: one production heartbeat refresh interval, advanced only on the fixture clock.
  heartbeatSeat(board, 'coordinator');
  assert.notEqual(store.agentById(board, 'coordinator').heartbeatAt, heartbeat, 'the native heartbeat really changes');
  assert.deepEqual(exportBoard(board), history, 'the private heartbeat does not mutate native business history');
  const changed = relayPresentation(box.repo, { board, observedAt: laterAt }, RELAY_PRESENTATION_PORTS);
  assert.ok(!changed.state.agents.some(seat => seat.agent_id === 'coordinator'), 'the heartbeat remains outside the displayed activity window');
  assert.notEqual(presentationDigest(changed), presentationDigest(later), 'a real heartbeat invalidates the sealed checkpoint even for a hidden seat');
});

test('a gone seat claim returns to the queue with a note [B3,B5,H16]', async t => {
  const { goneClaimFixture } = await import('../../tests/fixtures/presence.js');
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const { applyEngineMove } = await import('../../../../packages/state/index.js');
  const { GONE_CLAIM_ENGINE } = await import('../../../../packages/state/light.js');
  const { nativeBoardPorts } = await import('../../../lib/index.js');
  const { relaySenderProblem } = nativeBoardPorts().enginePorts;
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const f = goneClaimFixture(t);
  const id = f.claim();
  const lastSeen = store.agentById(f.board, f.owner).heartbeatAt;
  const prefix = exportBoard(f.board);
  f.advance(1_800_000 - 1);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'one millisecond before gone retains the two-hour lease');
  f.advance(1);
  await f.scan();
  const released = store.getItem(f.board, id);
  assert.equal(released.item_status, 'open');
  assert.equal(released.item_owner, null);
  assert.equal(released.item_lease_until, null);
  const event = store.events(f.board, { itemId: id }).at(-1);
  const detail = JSON.parse(event.event_detail);
  assert.equal(event.event_kind, 'release');
  assert.equal(event.event_by, 'coordinator', 'maintenance never impersonates the holder');
  assert.deepEqual(detail.goneSeat, { seat: f.owner, lastSeen });
  assert.equal(detail.reasonCode, 'BLOCKED');
  assert.ok(detail.reason.includes(f.owner) && detail.reason.includes(lastSeen));
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'web' }).item.item_id, id);
  await f.scan();
  assert.equal(f.moves.length, 1, 'maintenance is idempotent after the ordinary release');
  const replica = fixtureBoard(t, { clock: f.clock });
  importBoard(replica, prefix);
  heartbeatSeat(replica, f.owner);
  assert.equal(store.agentById(replica, f.owner).presence, 'live');
  const [{ move, options }] = f.moves;
  assert.ok(move.engine >= GONE_CLAIM_ENGINE);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: GONE_CLAIM_ENGINE - 1 }, options), error => error.code === 'RELAY_MOVE');
  assert.equal(relaySenderProblem(move, { kind: 'agent', userId: 'fixture-user', agent: f.other }, 'move').code, 'RELAY_SENDER_MISMATCH');
  assert.equal(relaySenderProblem(move, { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' }, 'move'), null);
  assert.equal(applyEngineMove(replica, move, options).error, undefined);
  assert.equal(store.getItem(replica, id).item_status, 'open', 'replay uses frozen observed evidence, not replica-local heartbeat');
});

test('gone claim maintenance is opt-in and preserves recent seats and ordinary authority [B3,B5,H2]', async t => {
  const { goneClaimFixture } = await import('../../tests/fixtures/presence.js');
  const { heartbeatSeat } = await import('../../../../packages/store/index.js');
  const { defaults, loadConfig, configFromSource } = await import('../../../../packages/config/index.js');
  const f = goneClaimFixture(t);
  const id = f.claim();
  assert.equal(defaults().claims.releaseGone, false);
  assert.equal(loadConfig(f.box.repo).claims.releaseGone, false);
  assert.equal(configFromSource('{"claims":{"releaseGone":true}}').claims.releaseGone, true);
  assert.throws(() => configFromSource('{"claims":{"releaseGone":"true"}}'), error => error.code === 'BAD_CONFIG');
  f.advance(1_800_000);
  await f.scan(false);
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'off preserves the ordinary lease');
  await f.scan(true, f.other);
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'a peer cannot perform coordinator maintenance');
  heartbeatSeat(f.board, f.owner);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'active holder is retained');
  f.advance(1_800_000 - 1);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'recent heartbeat resets the exact gone boundary');
  const observation = { seat: f.owner, lastSeen: store.agentById(f.board, f.owner).heartbeatAt };
  assert.throws(() => store.release(f.board, id, f.other, '', observation, 'BLOCKED'), error => error.code === 'NOT_YOURS');
  assert.throws(() => store.release(f.board, id, 'coordinator', '', observation, 'BLOCKED'), error => error.code === 'NOT_YOURS');
  f.advance(1);
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'Outside approval is pending' });
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.equal(store.itemHold(f.board, id).item_hold_reason, 'Outside approval is pending');
  assert.throws(() => store.claim(f.board, id, { agentId: f.other, lane: 'web', leaseMs: 7_200_000, freeze: f.freeze }), error => error.code === 'ITEM_HELD');
});

test('gone maintenance leaves unknown imported holders and submitted reviews alone [B3,V1,H16]', async t => {
  const { goneClaimFixture } = await import('../../tests/fixtures/presence.js');
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const { releaseGoneClaims } = await import('../../../../packages/sentinels/index.js');
  const { submitFixture } = await import('../../tests/fixtures/board/submit.js');
  const f = goneClaimFixture(t);
  const id = f.claim();
  const replica = fixtureBoard(t, { clock: f.clock });
  importBoard(replica, exportBoard(f.board));
  f.advance(1_800_000);
  let attempted = false;
  await releaseGoneClaims({ config: { claims: { releaseGone: true } } }, replica, { id: 'coordinator' }, async () => { attempted = true; });
  assert.equal(attempted, false, 'missing local/imported observations are not authority');
  assert.equal(store.getItem(replica, id).item_status, 'claimed');
  // Synthetic submission metadata sets up lifecycle state only; it is not a gate proof.
  submitFixture(f.board, id, { agentId: f.owner, commit: 'a'.repeat(40), tree: 'fixture-tree' });
  assert.throws(() => store.reserveReview(f.board, id, { agentId: f.owner, leaseMs: 7_200_000, policy: 'any' }), error => error.code === 'SELF_VERIFY');
  store.reserveReview(f.board, id, { agentId: f.other, leaseMs: 7_200_000, policy: 'any' });
  f.advance(1_800_000);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'submitted');
  assert.equal(store.getItem(f.board, id).item_review_by, f.other);
  assert.equal(f.moves.length, 0, 'gone build maintenance never frees an independent review reservation');
});


test('native and ordered gone releases retain coded evidence and historical event shape [B3,C7,H16]', async t => {
  const { goneClaimFixture } = await import('../../tests/fixtures/presence.js');
  const { applyEngineMove, prepareEngineMove } = await import('../../../../packages/state/index.js');
  const { GONE_CLAIM_ENGINE } = await import('../../../../packages/state/light.js');
  const { RELEASE_REASONS_ENGINE } = await import('../../../../packages/state/light.js');
  for (const mode of ['native', 'ordered', 'historical']) {
    const f = goneClaimFixture(t);
    store.register(f.board, { lane: 'coordinator', path: f.box.repo, model: 'Coded maintenance fixture' });
    const id = f.claim();
    const observation = { seat: f.owner, lastSeen: store.agentById(f.board, f.owner).heartbeatAt };
    f.advance(1_800_000);
    const before = store.getItem(f.board, id), events = store.events(f.board);
    for (const code of [undefined, 'NOPE']) {
      assert.throws(() => store.release(f.board, id, 'coordinator', '', observation, code), { code: 'RELEASE_REASON' });
      assert.deepEqual(store.getItem(f.board, id), before);
      assert.deepEqual(store.events(f.board), events);
    }
    assert.throws(() => store.release(f.board, id, f.other, '', observation, 'BLOCKED'), { code: 'NOT_YOURS' });
    assert.deepEqual(store.events(f.board), events, 'a real code cannot grant maintenance authority');
    const args = [id, 'coordinator', '', observation, 'BLOCKED'];
    const move = prepareEngineMove(f.board, 'release', args);
    assert.ok(move.engine >= RELEASE_REASONS_ENGINE);
    const options = { sequence: 1, at: f.clock.now().toISOString() };
    assert.throws(() => applyEngineMove(f.board, { ...move, engine: GONE_CLAIM_ENGINE }, options), { code: 'RELAY_MOVE' });
    assert.deepEqual(store.getItem(f.board, id), before, 'an old writer cannot drop the supplied code');
    if (mode === 'native') store.release(f.board, id, 'coordinator', '', observation, 'BLOCKED');
    else {
      const selected = mode === 'historical'
        ? { ...prepareEngineMove(f.board, 'release', args.slice(0, 4)), engine: GONE_CLAIM_ENGINE }
        : move;
      const outcome = applyEngineMove(f.board, selected, options);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(applyEngineMove(f.board, selected, options), outcome, 'the same dual-argument move replays once');
    }
    assert.equal(store.getItem(f.board, id).item_status, 'open');
    const detail = JSON.parse(store.events(f.board, { itemId: id }).at(-1).event_detail);
    assert.deepEqual(detail.goneSeat, observation);
    assert.equal(detail.model, 'Coded maintenance fixture');
    assert.deepEqual(Object.keys(detail).sort(), mode === 'historical' ? ['goneSeat', 'model', 'reason'] : ['goneSeat', 'model', 'reason', 'reasonCode']);
    if (mode !== 'historical') assert.equal(detail.reasonCode, 'BLOCKED');
  }
});
