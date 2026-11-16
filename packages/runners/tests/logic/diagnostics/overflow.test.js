/** @pullboard-test-input apps/runner/index.js packages/resources/src/io/renewal.js */
/** A runner job's child spawn journal rotates instead of overflowing, so cleanup stays certain and reaps a hung child [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const SOURCE = join(import.meta.dirname, '../../../../..');
const CLEANUP_BUDGET_MS = 15_000;
const url = path => JSON.stringify(pathToFileURL(join(SOURCE, path)).href);

/** The job command root of the burst case: 700 receipts (about 215 bytes each) pass the 128 KiB one journal file holds. */
const BURST_ROOT = `
  const { spawn } = require('node:child_process');
  let left = 700;
  const batch = () => { if (left <= 0) return finish(); const wave = Math.min(left, 25); left -= wave;
    Promise.all(Array.from({ length: wave }, () => new Promise(done => spawn('true').on('close', done)))).then(batch); };
  function finish() {
    const sleeper = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    console.log('SLEEPER ' + sleeper.pid);
    setInterval(() => {}, 1000);
  }
  batch();`;

/**
 * Drive the runner's real descendant tracker from a child process (the cell's front door is not this test's to import).
 * The child launches a job root under the tracker's journal preload, ends the root as a finished command would, runs the
 * cleanup the worker runs, and prints what it found as one JSON line.
 */
const TRACKER_SCENARIO = `
  import { spawn } from 'node:child_process';
  import { existsSync, readdirSync } from 'node:fs';
  import { join } from 'node:path';
  const { createDescendantTracker } = await import(${url('apps/runner/index.js')});
  const [directory, mode, rootScript, budgetMs] = process.argv.slice(1);
  const budget = { endsAt: Infinity, spent: false };
  const tracker = createDescendantTracker(directory, { intervalMs: 100,
    timedOut: () => { budget.spent ||= Date.now() > budget.endsAt; return budget.spent; } });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const options = { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_OPTIONS: tracker.nodeOptions } };
  const root = mode === 'shell' ? spawn('/bin/sh', ['-c', 'sleep 600 & echo SLEEPER $!; wait'], options)
    : spawn(process.execPath, ['-e', rootScript], options);
  const rootClosed = new Promise(resolve => root.once('close', resolve));
  tracker.registerRoot(root.pid);
  const sleeper = await new Promise((resolve, reject) => {
    let text = '';
    root.stdout.on('data', part => { text += part; const hit = text.match(/SLEEPER (\\d+)/u); if (hit) resolve(Number(hit[1])); });
    root.once('close', () => reject(new Error('the job root exited before its sleeper started')));
  });
  const result = { sleeper };
  try {
    tracker.observe();
    result.tracked = tracker.cleanupState().live.some(identity => identity.pid === sleeper);
    if (mode === 'burst') process.kill(root.pid, 'SIGKILL'); // The command ends; its detached descendant is still the job's.
    const journal = join(directory, 'child-journal');
    result.journalFiles = readdirSync(journal).filter(name => /^children-/u.test(name)).length;
    result.overflow = existsSync(join(journal, 'overflow'));
    budget.endsAt = Date.now() + Number(budgetMs);
    await tracker.stopDescendants(); // A shell root shares its sleeper's group, so one owned-group signal takes both.
    await Promise.race([rootClosed, new Promise(resolve => setTimeout(resolve, 5000))]);
    await tracker.verifyAfterGroups();
    result.budgetSpent = budget.spent;
    result.uncertain = tracker.cleanupState().uncertain;
    result.rootAlive = alive(root.pid);
    result.sleeperAlive = alive(sleeper);
  } finally {
    tracker.stopMonitoring();
    for (const pid of [root.pid, sleeper]) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
  }
  console.log(JSON.stringify(result));
  process.exit(0);`;

/** Run one tracker scenario in its own node process and parse its last line. */
function scenario(t, mode) {
  const directory = privateFixtureFiles('pullboard-journal-overflow-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', TRACKER_SCENARIO, directory, mode, BURST_ROOT, String(CLEANUP_BUDGET_MS)],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ } });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.once('close', code => {
      const line = stdout.trim().split('\n').at(-1) ?? '';
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`scenario ${mode} exited ${code} without a result: ${stderr.slice(-800)}`)); }
    });
  });
}

test('a spawn burst past one journal file rotates, so cleanup is certain and reaps the child that never exits [C7]', { timeout: 120_000 }, async t => {
  const run = await scenario(t, 'burst');
  assert.equal(run.tracked, true, 'custody proved the detached sleeper through the burst');
  assert.equal(run.overflow, false, 'a burst must not write the overflow marker');
  assert.ok(run.journalFiles >= 2, `the burst rotated to a second journal file (${run.journalFiles})`);
  assert.equal(run.budgetSpent, false, 'cleanup finished inside its budget, not by running it out');
  assert.equal(run.uncertain, false, 'custody stayed certain, so no RUNNER_CLEANUP_TIMEOUT for unverifiable custody');
  assert.equal(run.sleeperAlive, false, 'the child that never exits is stopped');
});

test('a job shell whose child never exits is stopped with its whole group and leaves no stray /bin/sh [C7]', { timeout: 60_000 }, async t => {
  const run = await scenario(t, 'shell');
  assert.equal(run.tracked, true);
  assert.equal(run.budgetSpent, false);
  assert.equal(run.uncertain, false);
  assert.equal(run.rootAlive, false, 'no stray /bin/sh');
  assert.equal(run.sleeperAlive, false, 'no stray sleeper');
});

test('a renewal beat thread started under --input-type=module survives instead of respawning at every renewal [C7]', { timeout: 60_000 }, async t => {
  const directory = privateFixtureFiles('pullboard-beat-module-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'slots.sqlite');
  // An ESM parent, like the failover fixtures' `node --input-type=module -e`: the worker once inherited that flag, parsed
  // its CommonJS source as a module, died on `require`, and was started again by the next renewal, 25 times a second.
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const threads = process.getBuiltinModule('node:worker_threads');
    let made = 0;
    threads.Worker = new Proxy(threads.Worker, { construct(target, args, newTarget) { made += 1; return Reflect.construct(target, args, newTarget); } });
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
    const { renewWithBeat, tuneRenewalBeat } = await import(${url('packages/resources/src/io/renewal.js')});
    tuneRenewalBeat({ beatMs: 20 });
    const db = new DatabaseSync(${JSON.stringify(database)});
    db.exec('CREATE TABLE waiter (token TEXT PRIMARY KEY, heartbeat INTEGER)');
    db.prepare('INSERT INTO waiter VALUES (?, 0)').run('queued');
    for (let renewal = 0; renewal < 30; renewal += 1) await renewWithBeat(${JSON.stringify(database)}, 'queued', true, () => new Promise(done => setTimeout(done, 40)));
    const heartbeat = db.prepare('SELECT heartbeat FROM waiter').get().heartbeat;
    console.log(JSON.stringify({ made, beat: heartbeat > 0 }));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const output = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', part => { text += part; });
    child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`beat fixture exited ${code}`)));
  });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), { made: 1, beat: true },
    'one beat thread served all thirty renewals and refreshed the queue heartbeat');
});
