/** Seat identity survives heartbeat-based presence changes on a real SQLite board [B3]. */
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
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
import * as store from '../../../../../packages/store/index.js';
import {
  readFileSync,
} from 'node:fs';
import {
  DatabaseSync,
} from 'node:sqlite';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

test('local heartbeats revive a seat without changing exported history or a remote copy [B3,A7]', async (t) => {
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
  const { exportBoard, importBoard } = await import('../../../../../packages/store/index.js');
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
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const { relaySnapshot } = await import('../../../../../packages/pages/index.js');
  const { exportBoard, importBoard } = await import('../../../../../packages/store/index.js');
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
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
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const { readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { projectState } = await import('../../../src/io/view.js');
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
  const status = await box.runIn(box.web, 'status', '--json');
  const explicit = await box.runIn(box.web, 'heartbeat', '--json');
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
  // Real process on purpose: the claim is about a separate CLI process, so this call must not share this one.
  const heartbeat = box.run(box.web, 'heartbeat', '--json');
  assert.equal(heartbeat.code, 0, heartbeat.err + heartbeat.out);
  assert.equal(JSON.parse(heartbeat.out).presence, 'live');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'a separate CLI process in the same minute performs no additional heartbeat write');
});

test('an imported board never inherits a same-path coordinator heartbeat [B3,A7]', async (t) => {
  const { exportBoard, importBoard } = await import('../../../../../packages/store/index.js');
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
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
  const { JSON_SHAPES } = await import('../../../../../packages/config/index.js');
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
  const plain = await box.runIn(box.web, 'status');
  assert.equal(plain.code, 0, plain.err + plain.out);
  assert.match(plain.out, /seats: 2 live, 1 idle, 100 gone/u);
  assert.ok(plain.out.includes(`${idle}: idle`));
  assert.ok(gone.every(id => !plain.out.includes(`${id}: gone`)), 'plain status never prints historical gone rows');
  const all = await box.runIn(box.web, 'status', '--all');
  assert.equal(all.code, 0, all.err + all.out);
  assert.ok(gone.every(id => all.out.includes(`${id}: gone`)), 'the explicit flag retains access to every identity');
  const structured = await box.runIn(box.web, 'status', '--json');
  assert.equal(structured.code, 0, structured.err + structured.out);
  const summary = JSON.parse(structured.out);
  assert.deepEqual(summary.presenceCounts, { live: 2, idle: 1, gone: 100 });
  assert.equal(summary.agents.length, 103, 'JSON may retain full history per outside1705');
  assert.equal(JSON_SHAPES.commands.heartbeat.required.seat, 'string|null');
  assert.equal(JSON_SHAPES.commands.heartbeat.required.heartbeatAt, 'string|null');
});
