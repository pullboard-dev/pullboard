/** One live dispatcher, always on main tooling: an older one stops launching, lets its workers finish and hands over (DJ16) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { dispatcherPass } from '../../../index.js';
import { handOver } from '../../../index.js';
import { staleDispatcherTools } from '../../../index.js';
import { drainHandoffQueue } from '../../../../resources/index.js';
import { finishRunningWorkers } from '../../../../resources/index.js';
import { listResources } from '../../../../resources/index.js';
import { queueHandoffLaunch } from '../../../../resources/index.js';
import { reserveHandoffTicket } from '../../../../resources/index.js';

/** The commit a tool root's HEAD names, read with real git as the dispatcher binary does. */
const head = root => runFixtureGit(['-C', root, 'rev-parse', 'HEAD']);

/** A tool root at one commit, and two waiting launches: one captured at an older tooling commit, one at its HEAD. */
function launchesAtTwoCommits(t) {
  const tool = privateFixtureFiles('pullboard-dispatch-tool-root-');
  for (const args of [['init', '-q'], ['config', 'user.email', 'dispatch@example.test'], ['config', 'user.name', 'Dispatch Test']]) runFixtureGit(['-C', tool.root, ...args]);
  tool.write('packages/drive/index.js', 'export const VERSION = 1;\n');
  runFixtureGit(['-C', tool.root, 'add', '-A']);
  runFixtureGit(['-C', tool.root, 'commit', '-q', '-m', 'tooling A']);
  const a = runFixtureGit(['-C', tool.root, 'rev-parse', 'HEAD']);
  tool.write('packages/drive/index.js', 'export const VERSION = 2;\n');
  runFixtureGit(['-C', tool.root, 'commit', '-q', '-am', 'tooling B']);
  const b = runFixtureGit(['-C', tool.root, 'rev-parse', 'HEAD']);
  const snapshots = privateFixtureFiles('pullboard-dispatch-snapshots-');
  const folder = commit => { const path = join(snapshots.root, `pullboard-handoff-tools-${commit}`); mkdirSync(path, { recursive: true }); return path; };
  const launch = (job, commit) => {
    const files = privateFixtureFiles('pullboard-dispatch-job-');
    files.write('request.json', JSON.stringify({ job, toolRoot: tool.root, toolsCommit: commit }) + '\n');
    return { directory: files.root, job, tools: folder(commit) };
  };
  const launches = [launch('job-old', a), launch('job-new', b)];
  t.after(() => rmSync(snapshots.root, { recursive: true, force: true }));
  return { launches, old: launches[0].tools, current: launches[1].tools };
}

test('clause 1: a dispatcher whose tools snapshot is not its tool root\'s current main tooling names the current tooling, and one on main names none [C7]', t => {
  const { launches, old, current } = launchesAtTwoCommits(t);
  assert.equal(staleDispatcherTools({ own: old, launches: () => launches, head }), current, 'a dispatcher on older tools is handed the snapshot captured at main\'s HEAD');
  assert.equal(staleDispatcherTools({ own: current, launches: () => launches, head }), null, 'a dispatcher on main tooling keeps launching, though an older launch still waits');
  assert.equal(staleDispatcherTools({ own: '/Users/example/pullboard', launches: () => launches, head }), null, 'a dispatcher run from a checkout never hands over');
  assert.equal(staleDispatcherTools({ own: old, launches: () => [launches[0]], head }), null, 'with no launch captured at main\'s HEAD there is nothing to hand over to');
});

test('clause 1: a stale dispatcher stops taking jobs, frees the machine lock, launches one on main tooling, lets its workers finish and exits [C7]', async () => {
  const home = privateFixtureFiles('pullboard-dispatch-home-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(home.root, 'home');
  try {
    const directory = join(home.root, 'job');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), '{}\n');
    queueHandoffLaunch({ directory, tools: join(home.root, 'tools'), commonDir: home.root, job: 'job-stale' }, await reserveHandoffTicket('job-stale'));
    const row = { renewed: 0, released: 0, renew() { this.renewed += 1; }, release() { this.released += 1; }, withDb() {} };
    const onPass = dispatcherPass(row, { stale: () => '/tmp/current-tools', finish: () => {} });
    const error = await drainHandoffQueue({ capacity: 1, pollMs: 20, onPass }).then(() => null, caught => caught);
    assert.equal(error?.code, 'DISPATCHER_TOOLS_STALE', 'the stale pass ended the drain before any launch');
    assert.equal(error.tools, '/tmp/current-tools');
    const held = listResources({ scope: 'machine' }).find(resource => resource.name === 'submit-handoff-dispatcher');
    assert.ok(!held?.holders?.length, 'the machine lock is free for the dispatcher on current tooling');
    const launched = [];
    const order = [];
    // One gate this dispatcher started is still running at the hand-over; it ends once the new dispatcher is up.
    const worker = { exited: false, slot: 'slot-1', job: 'job-running' };
    const running = new Map([['worker-1', worker]]);
    const launch = async (tools, cwd, options) => { launched.push({ tools, cwd, owner: options.owner }); order.push('launched'); worker.exited = true; return true; };
    const finish = workers => finishRunningWorkers(workers, { pollMs: 5, releaseSlot: slot => order.push(`released ${slot}`) });
    await handOver(error.tools, code => order.push(`exit ${code}`), { launch, running, finish, owner: 'dispatcher:row-owner' });
    assert.equal(launched[0].owner, 'dispatcher:row-owner', 'the successor takes over the row this dispatcher renewed');
    assert.deepEqual(launched.map(entry => entry.tools), ['/tmp/current-tools'], 'one dispatcher is launched, from current main tooling');
    assert.deepEqual(order, ['launched', 'released slot-1', 'exit 0'], 'it let its running gate finish, freed its slot, then exited');
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(home.root, { recursive: true, force: true });
  }
});

test('clause 2: a dispatcher whose row another dispatcher took stops launching at once and launches no other [C7]', async () => {
  const home = privateFixtureFiles('pullboard-dispatch-replaced-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(home.root, 'home');
  try {
    const directory = join(home.root, 'job');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), '{}\n');
    queueHandoffLaunch({ directory, tools: join(home.root, 'tools'), commonDir: home.root, job: 'job-replaced' }, await reserveHandoffTicket('job-replaced'));
    const row = { released: 0, renew: () => false, release() { this.released += 1; }, withDb() {} };
    const onPass = dispatcherPass(row, { stale: () => null, finish: () => {} });
    const error = await drainHandoffQueue({ capacity: 1, pollMs: 20, onPass }).then(() => null, caught => caught);
    assert.equal(error?.code, 'DISPATCHER_REPLACED', 'the first pass after the row moved ends the drain');
    const launched = [];
    const exits = [];
    await handOver(error.tools, code => exits.push(code), { launch: async (...args) => { launched.push(args); return true; }, finish: async () => {} });
    assert.deepEqual(launched, [], 'it leaves the machine to the dispatcher that took the row');
    assert.equal(row.released, 0, 'it never frees a row it no longer holds');
    assert.deepEqual(exits, [0]);
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(home.root, { recursive: true, force: true });
  }
});
