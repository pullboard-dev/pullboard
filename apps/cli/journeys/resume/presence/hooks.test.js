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
  writeFileSync,
} from 'node:fs';
import {
  runCliInProcess,
} from '../../../tests/fixtures/process.js';
import {
  fixtureAdd,
} from '../../../tests/fixtures/testkit.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

test('a local heartbeat persists once per minute and refreshes after clock rollback [B3,C7]', async (t) => {
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
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
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const { DatabaseSync } = await import('node:sqlite');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const { runCliInProcess } = await import('../../../tests/fixtures/process.js');
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
  const { runFixtureChild } = await import('../../../tests/fixtures/child.js');
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

test('explicit SessionStart observation upgrades an existing resume hook without rewriting it [B3,I6]', async (t) => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
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

test('checkpoint fingerprints retain hidden-seat heartbeats without treating clock movement as a write [B3,H16]', async t => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
  const { exportBoard } = await import('../../../../../packages/store/index.js');
  const { relayPresentation, presentationDigest } = await import('../../../../../packages/pages/index.js');
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
