/** One live dispatcher, always on main tooling: an older one stops launching, lets its workers finish and hands over (DJ16) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { currentToolsName } from '../apps/cli/src/shell/submit-handoff.js';
import { dispatcherPass, handOver, staleDispatcherTools } from '../bin/handoff-worker-dispatcher.js';
import { drainHandoffQueue, finishRunningWorkers, listResources, queueHandoffLaunch, reserveHandoffTicket } from '../packages/resources/index.js';

/** A clean tool root at one commit and a waiting launch whose request names it. */
function toolRootWithLaunch() {
  const tool = privateFixtureFiles('pullboard-dispatch-tool-root-');
  for (const args of [['init', '-q'], ['config', 'user.email', 'dispatch@example.test'], ['config', 'user.name', 'Dispatch Test']]) runFixtureGit(['-C', tool.root, ...args]);
  tool.write('packages/drive/index.js', 'export const VERSION = 1;\n');
  runFixtureGit(['-C', tool.root, 'add', '-A']);
  runFixtureGit(['-C', tool.root, 'commit', '-q', '-m', 'tooling']);
  const job = privateFixtureFiles('pullboard-dispatch-job-');
  job.write('request.json', JSON.stringify({ job: 'job-stale', toolRoot: tool.root }) + '\n');
  return { tool, launch: { directory: job.root, job: 'job-stale', commonDir: join(tool.root, '.git') } };
}

test('clause 1: a dispatcher whose tools snapshot is not its tool root\'s current main tooling names the current tooling, and one on main names none [C7]', () => {
  const { tool, launch } = toolRootWithLaunch();
  const current = currentToolsName(tool.root);
  assert.match(current, /^pullboard-handoff-tools-[0-9a-f]{40}$/u);
  const built = [];
  const snapshot = (root, job) => { built.push([root, job]); return `/tmp/${current}`; };
  const stale = '/tmp/pullboard-handoff-tools-' + '0'.repeat(40);
  assert.equal(staleDispatcherTools({ own: stale, launches: () => [launch], snapshot }), `/tmp/${current}`, 'a stale dispatcher is handed the current snapshot');
  assert.deepEqual(built, [[tool.root, 'job-stale']], 'the current snapshot is built from the tool root the launch names');
  assert.equal(staleDispatcherTools({ own: `/tmp/${current}`, launches: () => [launch], snapshot }), null, 'a dispatcher on current tooling keeps launching');
  assert.equal(staleDispatcherTools({ own: tool.root, launches: () => [launch], snapshot }), null, 'a dispatcher run from a checkout never hands over');
  assert.equal(staleDispatcherTools({ own: stale, launches: () => [], snapshot }), null, 'with nothing waiting there is nothing to hand over');
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
    const launch = async (tools, cwd) => { launched.push({ tools, cwd }); order.push('launched'); worker.exited = true; return true; };
    const finish = workers => finishRunningWorkers(workers, { pollMs: 5, releaseSlot: slot => order.push(`released ${slot}`) });
    await handOver(error.tools, row, code => order.push(`exit ${code}`), { launch, running, finish });
    assert.equal(row.released, 1, 'the stale dispatcher freed its row first');
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
    await handOver(error.tools, row, code => exits.push(code), { launch: async (...args) => { launched.push(args); return true; }, finish: async () => {} });
    assert.deepEqual(launched, [], 'it leaves the machine to the dispatcher that took the row');
    assert.equal(row.released, 0, 'it never frees a row it no longer holds');
    assert.deepEqual(exits, [0]);
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(home.root, { recursive: true, force: true });
  }
});
