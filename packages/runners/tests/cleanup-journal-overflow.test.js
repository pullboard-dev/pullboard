/** @pullboard-test-input source-tree */
/** A runner job's child spawn journal rotates instead of overflowing, so cleanup stays certain and reaps a hung child [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createDescendantTracker } from '../../../apps/runner/index.js';
import { privateFixtureFiles } from '../../../test/fixture-child.js';

const SOURCE = join(import.meta.dirname, '../../..');
const CLEANUP_BUDGET_MS = 15_000;

/** Whether the kernel still has this process (a zombie awaiting a reaper still counts as gone for a signalled child). */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Resolve when the child's stdout has printed a line starting with the marker; reject if it exits first. */
function lineFrom(child, marker) {
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', part => {
      text += part;
      const hit = text.split('\n').find(line => line.startsWith(marker));
      if (hit) resolve(hit.slice(marker.length).trim());
    });
    child.once('close', code => reject(new Error(`fixture exited ${code} before ${marker}`)));
  });
}

/** A job directory, a tracker over it, and teardown that leaves no process behind even when an assertion fails. */
function job(t, hooks = {}) {
  const directory = privateFixtureFiles('pullboard-journal-overflow-').root;
  const pids = [];
  const tracker = createDescendantTracker(directory, { intervalMs: 100, ...hooks });
  t.after(() => {
    tracker.stopMonitoring();
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, tracker, pids };
}

/** Start a node fixture as the job's command root, under the journal preload exactly as the runner does. */
function launch(tracker, pids, script) {
  const root = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: tracker.nodeOptions } });
  pids.push(root.pid);
  tracker.registerRoot(root.pid);
  return root;
}

test('a spawn burst past one journal file rotates, so cleanup is certain and reaps the child that never exits [C7]', { timeout: 120_000 }, async t => {
  const budget = { endsAt: Infinity, spent: false };
  const { directory, tracker, pids } = job(t, { timedOut: () => { budget.spent ||= Date.now() > budget.endsAt; return budget.spent; } });
  // 700 receipts of about 215 bytes are past the 128 KiB a journal file holds; the sleeper outlives its launcher.
  const root = launch(tracker, pids, `
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
    batch();`);
  const sleeper = Number(await lineFrom(root, 'SLEEPER '));
  pids.push(sleeper);
  tracker.observe();
  assert.ok(tracker.cleanupState().live.some(identity => identity.pid === sleeper), 'custody proved the detached sleeper through the burst');
  process.kill(root.pid, 'SIGKILL'); // The command ends; its detached descendant is reparented and still the job's.
  const journals = readdirSync(join(directory, 'child-journal'));
  assert.ok(journals.filter(name => /^children-\d+.*\.jsonl$/u.test(name)).length >= 2, `the burst rotated to a second journal file: ${journals.join(' ')}`);
  assert.equal(existsSync(join(directory, 'child-journal', 'overflow')), false, 'a burst must not write the overflow marker');
  const started = Date.now();
  budget.endsAt = started + CLEANUP_BUDGET_MS;
  await tracker.stopDescendants();
  await tracker.verifyAfterGroups();
  assert.equal(budget.spent, false, 'cleanup finished inside its budget, not by running it out');
  assert.equal(tracker.cleanupState().uncertain, false, 'custody stayed certain: no RUNNER_CLEANUP_TIMEOUT for unverifiable custody');
  assert.equal(alive(sleeper), false, 'the child that never exits is stopped');
});

test('a job shell whose child never exits is stopped with its whole group and leaves no stray /bin/sh [C7]', { timeout: 60_000 }, async t => {
  const { tracker, pids } = job(t);
  const root = spawn('/bin/sh', ['-c', 'sleep 600 & echo SLEEPER $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  pids.push(root.pid);
  tracker.registerRoot(root.pid);
  const sleeper = Number(await lineFrom(root, 'SLEEPER '));
  pids.push(sleeper);
  tracker.observe();
  const closed = new Promise(resolve => root.once('close', resolve));
  await tracker.stopDescendants(); // The sleeper shares the shell's group, so the owned group signal takes both.
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the job shell survived cleanup')), CLEANUP_BUDGET_MS))]);
  await tracker.verifyAfterGroups();
  assert.equal(alive(root.pid), false, 'no stray /bin/sh');
  assert.equal(alive(sleeper), false, 'no stray sleeper');
  assert.equal(tracker.cleanupState().uncertain, false);
});

test('a renewal beat thread started under --input-type=module survives instead of respawning at every renewal [C7]', { timeout: 60_000 }, async t => {
  const directory = privateFixtureFiles('pullboard-beat-module-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'slots.sqlite');
  const beat = pathToFileURL(join(SOURCE, 'packages/resources/src/shell/renewal-beat.js')).href;
  // An ESM parent, like the failover fixtures' `node --input-type=module -e`: the worker once inherited that flag, parsed
  // its CommonJS source as a module, died on `require`, and was started again by the next renewal, 25 times a second.
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const threads = process.getBuiltinModule('node:worker_threads');
    let made = 0;
    threads.Worker = new Proxy(threads.Worker, { construct(target, args, newTarget) { made += 1; return Reflect.construct(target, args, newTarget); } });
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
    const { renewWithBeat, tuneRenewalBeat } = await import(${JSON.stringify(beat)});
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
