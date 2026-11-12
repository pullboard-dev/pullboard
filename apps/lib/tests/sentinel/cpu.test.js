/** Native process observations exercise real durable board notifications [A6,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { scanHealthSentinel } from '../../../../packages/sentinels/index.js';
import { CPU_SENTINEL_ENGINE } from '../../../../packages/state/light.js';
import { HEALTH_SHOUT_CAP } from '../../../../packages/store/index.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';

// CPU time is observed, not burned: the native utility port supplies an exact ps/lsof transcript.
test('the sentinel names an agent process past 20 CPU minutes once [A6,H16]', async t => {
  const { agentCpuFindings } = await import('../../../../packages/sentinels/index.js');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cpu-'));
  const root = join(directory, 'repo'), work = join(directory, 'core');
  mkdirSync(root); mkdirSync(work);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  const file = join(directory, 'board.sqlite');
  // @pullboard-board-file persistence: the board is closed and reopened to check the delivery queue survives
  let board = openBoard(file);
  store.register(board, { lane: 'coordinator', path: root });
  const seat = store.register(board, { lane: 'core', path: work });
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true }); });
  let birth = 'Mon Oct 19 12:00:00 2026', cpu = '21:30.00', cwd = work, present = true, unavailable = false, host = 'host-a', pids = [4321];
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (unavailable) throw new Error('native observation unavailable');
    if (command === '/bin/ps') return present ? pids.map(pid => ` ${pid} ${cpu} ${birth} /usr/bin/git\n`).join('') + ` 9999 19:59.99 ${birth} /usr/bin/node\n` : '';
    assert.equal(command, '/usr/sbin/lsof');
    return pids.map(pid => `p${pid}\nn${cwd}\n`).join('');
  };
  const observe = () => agentCpuFindings(board.db, { platform: 'darwin', run, host });
  const scan = () => {
    const observation = scanHealthSentinel(file, { root, config: {}, now: new Date(), cpu: observe });
    if (observation) store.recordHealthFindings(board, { agentId: 'coordinator', ...observation });
  };
  scan();
  const notices = () => store.allShouts(board).filter(row => row.shout_to === 'coordinator' && row.shout_text.startsWith('Stuck:') && row.shout_text.includes('AGENT_CPU'));
  assert.equal(notices().length, 1);
  for (const value of ['4321', 'git', seat, '21.50 CPU minutes']) assert.ok(notices()[0].shout_text.includes(value), value);
  assert.equal(notices()[0].shout_from, 'sentinel');
  const moved = join(directory, 'another-seat'); mkdirSync(moved);
  store.register(board, { lane: 'core', path: moved }); cwd = moved; scan(); cwd = work;
  assert.equal(notices().length, 1, 'the same process changing worktree does not create another alert');
  unavailable = true; scan(); unavailable = false;
  assert.equal(store.allShouts(board).filter(row => row.shout_text.startsWith('Resolved:') && row.shout_text.includes('AGENT_CPU')).length, 0, 'an unavailable observation does not claim resolution');
  cpu = '01:22:30'; scan(); scan();
  assert.equal(notices().length, 1, 'increasing CPU time does not create another process episode');
  present = false; scan(); present = true; scan();
  assert.equal(notices().length, 1, 'a temporary observation gap cannot repeat a recorded process alert');
  birth = 'Mon Oct 19 13:00:00 2026'; scan();
  assert.equal(notices().length, 2, 'a reused PID with a different birth is a different process');
  cwd = join(directory, 'core-other'); mkdirSync(cwd); birth = 'Mon Oct 19 14:00:00 2026';
  scan(); assert.equal(notices().length, 2, 'a path-prefix sibling is not an agent worktree');
  cwd = work; cpu = '20:00.00'; scan();
  assert.equal(notices().length, 2, 'exactly twenty CPU minutes has not exceeded twenty minutes');
  cpu = '1-00:00:01';
  assert.equal(observe()[0].why.includes('1440.02 CPU minutes'), true, 'day-form CPU time is parsed');
  assert.equal(agentCpuFindings(board.db, { platform: 'linux', run, readLink: path => { assert.equal(path, '/proc/4321/cwd'); return work; } })[0].cause, 'AGENT_CPU');
  host = 'host-a'; scan();
  const beforeHost = notices().length;
  host = 'host-b'; scan();
  assert.equal(notices().length, beforeHost + 1, 'equal PID and birth on another host is a different process');
  const resolved = store.allShouts(board).filter(row => row.shout_text.startsWith('Resolved:') && row.shout_text.includes('AGENT_CPU')).length;
  host = 'host-a'; scan(); host = 'host-b'; scan();
  assert.equal(notices().length, beforeHost + 1, 'alternating hosts do not repeat each other’s alert');
  assert.equal(store.allShouts(board).filter(row => row.shout_text.startsWith('Resolved:') && row.shout_text.includes('AGENT_CPU')).length, resolved, 'one host cannot resolve another host’s observation');
  host = 'cap-host'; birth = 'Mon Oct 19 15:00:00 2026'; pids = Array.from({ length: 12 }, (_, index) => 5001 + index);
  const beforeCap = notices().length;
  const failureCount = () => store.events(board).filter(event => event.event_kind === 'health-failure').length;
  const failuresBefore = failureCount();
  const cappedScan = () => {
    const count = store.allShouts(board).length; scan();
    assert.ok(store.allShouts(board).length - count <= HEALTH_SHOUT_CAP + 1, 'cap ten plus one summary remains unchanged');
  };
  cappedScan();
  assert.equal(notices().length - beforeCap, 5, 'sixth and later coordinator alerts wait rather than exceed the cap');
  const pendingEvents = store.events(board);
  const emptyMove = prepareEngineMove(board, 'recordHealthFindings', [{
    agentId: 'coordinator', observedRevision: pendingEvents.length, findings: [],
  }], { actor: 'coordinator' });
  assert.throws(() => applyRelayMove(board, { ...emptyMove, engine: CPU_SENTINEL_ENGINE - 1 }, {
    sequence: 1, at: new Date().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' },
  }), { code: 'RELAY_MOVE' }, 'ordered old-engine input cannot erase the pending queue');
  board.executionEngineVersion = CPU_SENTINEL_ENGINE - 1;
  assert.throws(() => store.recordHealthFindings(board, {
    agentId: 'coordinator', observedRevision: pendingEvents.length, findings: [],
  }), { code: 'ENGINE_VERSION' }, 'an older empty scan cannot erase pending CPU delivery');
  assert.deepEqual(store.events(board), pendingEvents, 'refusal preserves the complete delivery queue and history');
  delete board.executionEngineVersion;
  // @pullboard-board-file persistence: the board is closed and reopened to check the delivery queue survives
  store.closeBoard(board); board = openBoard(file);
  cappedScan(); cappedScan();
  for (const pid of pids) assert.equal(notices().filter(row => row.shout_text.includes(`pid ${pid} `)).length, 1, `PID ${pid} is named exactly once after restart`);
  assert.equal(notices().length - beforeCap, pids.length);
  assert.equal(failureCount() - failuresBefore, pids.length, 'retrying capped delivery does not invent recurring health failures');
  const eventsAfter = store.events(board).length; scan();
  assert.equal(store.events(board).length, eventsAfter, 'a drained delivery queue makes no more events');
  board.executionEngineVersion = CPU_SENTINEL_ENGINE - 1;
  assert.throws(() => store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: eventsAfter, findings: observe() }), { code: 'ENGINE_VERSION' });
  delete board.executionEngineVersion;
  assert.ok(calls.some(([command, args]) => command === '/bin/ps' && args.includes('time=')));
  assert.ok(calls.some(([command]) => command === '/usr/sbin/lsof'));
});
