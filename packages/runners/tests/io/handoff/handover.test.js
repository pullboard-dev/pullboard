/** One live dispatcher, always on main tooling: an older one stops launching, lets its workers finish and hands over (DJ16) [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { waitForCondition } from '../../../../../apps/cli/tests/fixtures/runner/holders.js';
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

const RUNNERS = fileURLToPath(new URL('../../../index.js', import.meta.url));
const RESOURCES = fileURLToPath(new URL('../../../../resources/index.js', import.meta.url));

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/**
 * A real dispatcher process that starts two gate drivers on lifelines, as the drain does, and hands the machine over
 * telling only one of them (the other stands for a driver that never hears it); its gates never finish. Each driver
 * records when it is told and when it stops on its lifeline.
 */
function handedOverDispatcher(t) {
  const files = privateFixtureFiles('pullboard-handover-lifeline-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write('driver.mjs', [
    "import { writeFileSync } from 'node:fs';",
    `import { onDispatcherLifelineEnd } from ${JSON.stringify(RESOURCES)};`,
    "const [, , name] = process.argv;",
    "onDispatcherLifelineEnd(() => { writeFileSync(`${name}.stopped`, ''); process.exit(143); }, { onRelease: () => writeFileSync(`${name}.released`, '') });",
    'setInterval(() => {}, 1_000);',
  ].join('\n'));
  files.write('dispatcher.mjs', [
    "import { spawn } from 'node:child_process';",
    "import { once } from 'node:events';",
    "import { writeFileSync } from 'node:fs';",
    `import { handOver } from ${JSON.stringify(RUNNERS)};`,
    `import { releaseLifelines } from ${JSON.stringify(RESOURCES)};`,
    `const root = ${JSON.stringify(files.root)};`,
    'const start = name => spawn(process.execPath, [`${root}/driver.mjs`, `${root}/${name}`], { detached: true, stdio: [\'pipe\', \'ignore\', \'ignore\'], env: { ...process.env, PULLBOARD_WORKER_LIFELINE: \'1\' } });',
    "const told = start('told'), untold = start('untold');",
    'await Promise.all([once(told, \'spawn\'), once(untold, \'spawn\')]);',
    "writeFileSync(`${root}/pids.json`, JSON.stringify({ told: told.pid, untold: untold.pid }));",
    "const running = new Map([[told, { exited: false, worker: told, slot: 'told' }]]);",
    "const all = new Map([...running, [untold, { exited: false, worker: untold, slot: 'untold' }]]);",
    "handOver(null, code => process.exit(code), { running: all, release: () => releaseLifelines(running), finish: () => new Promise(() => {}) });",
  ].join('\n'));
  const dispatcher = spawn(process.execPath, [join(files.root, 'dispatcher.mjs')], { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = [];
  dispatcher.stderr.on('data', chunk => lines.push(String(chunk)));
  t.after(() => { try { process.kill(dispatcher.pid, 'SIGKILL'); } catch { /* already gone */ } });
  const pids = join(files.root, 'pids.json');
  return { dispatcher, lines, pids, path: name => join(files.root, name) };
}

test('clause 1: a dispatcher that hands over tells its running drivers first; a told driver keeps its gate when the dispatcher is killed, an untold one stops on its lifeline [C7,DJ16]', { timeout: 60_000 }, async t => {
  const run = handedOverDispatcher(t);
  await waitForCondition(() => existsSync(run.path('told.released')), 'the told driver heard the hand-over', { signal: t.signal });
  const { told, untold } = JSON.parse(readFileSync(run.pids, 'utf8'));
  t.after(() => { for (const pid of [told, untold]) try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.match(run.lines.join(''), /stops: another dispatcher took the row; 1 running gate driver\(s\) finish on their own/u, 'the hand-over line counts the drivers told');
  run.dispatcher.kill('SIGKILL');
  await waitForCondition(() => existsSync(run.path('untold.stopped')), 'the untold driver stops when its dispatcher dies', { signal: AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]) });
  assert.equal(existsSync(run.path('told.stopped')), false, 'the told driver never read the lifeline end as its stop');
  assert.equal(gone(told), false, 'the told driver still runs its gate after its dispatcher was killed');
});

test('clause 2: a handed-over dispatcher logs a stop signal with how many drivers still run, then exits as the signal would [C7]', { timeout: 60_000 }, async t => {
  const run = handedOverDispatcher(t);
  await waitForCondition(() => existsSync(run.path('told.released')), 'the hand-over happened', { signal: t.signal });
  const { told, untold } = JSON.parse(readFileSync(run.pids, 'utf8'));
  t.after(() => { for (const pid of [told, untold]) try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } });
  const closed = new Promise(resolve => run.dispatcher.once('close', code => resolve(code)));
  run.dispatcher.kill('SIGTERM');
  assert.equal(await closed, 143, 'it exits as SIGTERM would');
  assert.match(run.lines.join(''), new RegExp(`handed-over dispatcher ${run.dispatcher.pid} received SIGTERM with 2 gate driver\\(s\\) still running`, 'u'));
});

test('clause 2: a handed-over dispatcher logs its own exit once its gates finish [C7]', async () => {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = chunk => { lines.push(String(chunk)); return true; };
  const exits = [];
  const handlers = process.listenerCount('SIGTERM');
  try { await handOver(null, code => exits.push(code), { finish: async () => {} }); }
  finally { process.stderr.write = write; }
  assert.deepEqual(exits, [0]);
  assert.match(lines.join(''), new RegExp(`handed-over dispatcher ${process.pid} exits: its gate drivers finished`, 'u'));
  assert.equal(process.listenerCount('SIGTERM'), handlers, 'the signal handlers are removed once it exits');
});
