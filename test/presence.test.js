/** Seat identity survives heartbeat-based presence changes on a real SQLite board [B3]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';

test('a seat presence moves live to idle to gone from its heartbeat [B3]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-'));
  let at = Date.parse('2026-10-24T12:00:00Z');
  const board = store.openBoard(join(root, 'board.sqlite'), { now: () => new Date(at) });
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
  const { heartbeatSeat } = await import('../src/seat-presence.js');
  const { exportBoard, importBoard } = await import('../src/exchange.js');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-local-'));
  let at = Date.parse('2026-10-24T12:00:00Z');
  const clock = { now: () => new Date(at) };
  const board = store.openBoard(join(root, 'board.sqlite'), clock);
  const remote = store.openBoard(join(root, 'remote.sqlite'), clock);
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
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const { relaySnapshot } = await import('../src/relay-presentation.js');
  const { exportBoard, importBoard } = await import('../src/exchange.js');
  const { heartbeatSeat } = await import('../src/seat-presence.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  let at = Date.now();
  const clock = { now: () => new Date(at) };
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
  const remote = store.openBoard(join(box.dir, 'relay-reader.sqlite'), clock);
  t.after(() => { store.closeBoard(board); store.closeBoard(remote); });
  const id = store.register(board, { lane: 'core', path: join(box.dir, 'presence-seat') });
  const history = exportBoard(board);
  const snapshot = relaySnapshot(box.repo, { board });
  const nativeAgents = snapshot.presentation.state.agents;
  assert.equal(nativeAgents.find(seat => seat.agent_id === id).presence, 'live', 'the native snapshot includes an observed live seat');
  importBoard(remote, snapshot);
  const restored = relaySnapshot(box.repo, { board: remote });
  assert.deepEqual(restored.presentation.state.agents, nativeAgents, 'restoring and republishing a relay snapshot preserves every projected agent');
  assert.deepEqual(exportBoard(board), history, 'snapshot capture leaves native history unchanged');
  assert.deepEqual(exportBoard(remote), history, 'relay observations remain outside native exports');
  at += 10 * 60_000;
  assert.equal(relaySnapshot(box.repo, { board: remote }).presentation.state.agents.find(seat => seat.agent_id === id).presence, 'idle');
  at += 20 * 60_000;
  assert.equal(relaySnapshot(box.repo, { board: remote }).presentation.state.agents.find(seat => seat.agent_id === id).presence, 'gone');
  assert.equal(heartbeatSeat(remote, id), true, 'a real local heartbeat can independently refresh the reader');
  assert.equal(store.agentById(remote, id).presence, 'live');
});

test('status reads and explicit hooks heartbeat without a shared board write [B3,I6]', async (t) => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const { readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { projectState } = await import('../src/serve.js');
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
  const board = store.openBoard(file);
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
  const { exportBoard, importBoard } = await import('../src/exchange.js');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-identity-'));
  const clock = { now: () => new Date('2026-10-24T12:00:00Z') };
  const local = store.openBoard(join(root, 'local.sqlite'), clock);
  const foreign = store.openBoard(join(root, 'foreign.sqlite'), clock);
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
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const { heartbeatSeat } = await import('../src/seat-presence.js');
  const { JSON_SHAPES } = await import('../src/json.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  let at = Date.now() - 40 * 60_000;
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
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
  const { heartbeatSeat } = await import('../src/seat-presence.js');
  const { DatabaseSync } = await import('node:sqlite');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-presence-throttle-'));
  let at = Date.parse('2026-10-24T12:00:00.000Z');
  const file = join(root, 'board.sqlite');
  const board = store.openBoard(file, { now: () => new Date(at) });
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
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const { DatabaseSync } = await import('node:sqlite');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = box.run(box.repo, 'add', 'web', 'Read-only presence control', '--criterion', 'Keep the same item', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const withdrawn = box.run(box.repo, 'withdraw', String(id), 'Private read-only presence control', '--json');
  assert.equal(withdrawn.code, 0, withdrawn.err + withdrawn.out);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = store.openBoard(file);
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
    const status = box.run(box.web, 'status', '--json');
    assert.equal(status.code, 0, status.err + status.out);
    const summary = JSON.parse(status.out);
    assert.equal(summary.agents.find(seat => seat.agent_id === 'web-1').presence, 'gone', 'status projects the stored observation without reviving it');
    assert.equal(local.prepare('SELECT at FROM heartbeat WHERE seat=?').get(key).at, stale);
    for (const args of [['show', String(id), '--json'], ['list', '--json']]) {
      const result = box.run(box.web, ...args);
      assert.equal(result.code, 0, result.err + result.out);
      assert.equal(JSON.parse(result.out).version, 1);
    }
    const next = box.run(box.web, 'next', '--json');
    assert.ok([0, 1].includes(next.code), next.err + next.out);
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM item WHERE item_status='claimed'").get().n, 0, 'the next control really makes no claim');
    assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'none of the read commands writes the private sidecar');
  } finally { board.db.exec('ROLLBACK'); }
  const shouted = box.run(box.web, 'shout', 'coordinator', 'Committed write refreshes this seat', '--json');
  assert.equal(shouted.code, 0, shouted.err + shouted.out);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1);
  const shout = board.db.prepare('SELECT shout_at FROM shout WHERE shout_from=? ORDER BY shout_id DESC LIMIT 1').get('web-1');
  const observed = local.prepare('SELECT at FROM heartbeat WHERE seat=?').get(key).at;
  assert.ok(Date.parse(observed) >= Date.parse(shout.shout_at), 'the local refresh follows the committed native shout');
  local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(stale, key);
  local.exec('UPDATE writes SET n=0');
  const refused = box.run(box.web, 'shout', 'missing-reader', 'This write must refuse', '--json');
  assert.equal(refused.code, 1, refused.err + refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'NO_READER');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'a refused native write cannot refresh presence');
  const events = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const hook = box.run(box.web, 'heartbeat', '--json');
  assert.equal(hook.code, 0, hook.err + hook.out);
  assert.equal(JSON.parse(hook.out).presence, 'live');
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 1, 'an explicit agent hook still refreshes the stale private observation');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, events, 'the hook remains local, not an ordered move');
  local.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(stale, key);
  local.exec('UPDATE writes SET n=0');
  const resumed = box.run(box.web, 'resume', '--json');
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  assert.equal(local.prepare('SELECT n FROM writes').get().n, 0, 'public resume is not an activity hook');
  const { readFileSync } = await import('node:fs');
  const { runFixtureChild } = await import('./fixture-child.js');
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
    assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, events, `${event} never writes shared history`);
  }
});


test('explicit SessionStart observation upgrades an existing resume hook without rewriting it [B3,I6]', async (t) => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const file = join(box.repo, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const custom = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo custom; pullboard resume', timeout: 17 }] };
  settings.hooks.SessionStart = [custom];
  writeFileSync(file, JSON.stringify(settings));
  const upgraded = box.run(box.repo, 'init', '--verbose');
  assert.equal(upgraded.code, 0, upgraded.err + upgraded.out);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 2);
  assert.ok(after.hooks.SessionStart[0].hooks[0].command.includes('hook SessionStart'));
  assert.deepEqual(after.hooks.SessionStart[1], custom, 'the existing user hook bytes remain its own command');
  const again = box.run(box.repo, 'init', '--verbose');
  assert.equal(again.code, 0, again.err + again.out);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), after, 'repeated init never duplicates the observation hook');
});
