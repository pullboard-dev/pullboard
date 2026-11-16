/**
 * Repro, #2828 (8 Nov): a controller died while ssh kept its session open, its runner worker lived 5 h 40 min holding
 * its lease, and every heal probe read "runner resource lease is active", so two runners stayed dark. The invariant:
 * the runner's idle probe stops a worker its controller no longer names, leaves the controller's live job alone, and
 * the next probe proves the runner idle [C7]. Fails on 6166bf85ca^; passes after it.
 *
 * The runner is a local fixture: a private runner root with a real pinned-worker entrypoint, a real SQLite resource
 * pool and real worker processes; the probe runs as its own process, as the runner's health entry does.
 */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  gone,
  guardProcesses,
  hopCheck,
  scratch,
  waitUntil,
  within,
} from '../../../../../packages/gate/tests/fixtures/pipeline/kit.js';

/** The controller address every worker came from over SSH. */
const CONTROLLER = '10.20.30.40';
/** How old the holders are: past the 5-minute floor below which a holder is never judged an orphan. */
const AGE_MS = 10 * 60_000;

guardProcesses();

/**
 * One idle probe, in its own process with the runner's machine home and the controller's SSH session, as the
 * controller's heal probe reaches the runner's health entry.
 *
 * @param {{ root: string, machine: string }} runner
 * @param {string[]} liveJobs - The controller's live job ids.
 * @returns {{ idle: boolean, reason: string, orphansStopped?: number[], ms: number }}
 */
function probe(runner, liveJobs) {
  const source = `
    import { runnerIdleReply } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/runners/index.js')).href)};
    // A tree from before the orphan check has no observer module; its probe then runs as it did.
    const orphanObserver = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'apps/runner/src/io/orphans.js')).href)})
      .then(module => module.orphanObserver, error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return null; throw error; });
    const started = performance.now();
    const reply = runnerIdleReply(${JSON.stringify(runner.root)}, { nonce: ${JSON.stringify(randomUUID())}, idle: true, liveJobs: ${JSON.stringify(liveJobs)} }, undefined, orphanObserver);
    process.stdout.write(JSON.stringify({ ...reply, ms: performance.now() - started }));`;
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: runner.machine, SSH_CLIENT: `${CONTROLLER} 50000 22` } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('an orphaned runner worker is stopped by the idle probe and the runner is proven idle again [C7]', { timeout: 60_000 }, async () => {
  const dir = await scratch('orphan');
  const runner = { root: join(dir, 'runner'), machine: join(dir, 'machine') };
  const entry = join(runner.root, 'runtime', 'a'.repeat(64), 'apps/runner/src/io/scripts/worker.js');
  mkdirSync(join(entry, '..'), { recursive: true });
  mkdirSync(runner.machine, { recursive: true });
  writeFileSync(entry, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);\n");
  const pool = new DatabaseSync(join(runner.machine, 'resources.sqlite'));
  pool.exec('CREATE TABLE holder(token TEXT, name TEXT, pid INTEGER, agent TEXT, item TEXT, since TEXT)');
  const workers = [];
  /** Start one real worker from the pinned entrypoint over the controller's SSH session, holding a gate slot for `job`. */
  const worker = async job => {
    const child = spawn(process.execPath, [entry], { cwd: dir, stdio: 'ignore', env: { PATH: process.env.PATH, SSH_CLIENT: `${CONTROLLER} 50001 22` } });
    workers.push(child);
    await new Promise(resolveSpawn => child.once('spawn', resolveSpawn));
    pool.prepare('INSERT INTO holder VALUES(?,?,?,?,?,?)').run(randomUUID(), 'gate', child.pid, `pullboard-ssh-${randomUUID()}`, job, new Date(Date.now() - AGE_MS).toISOString());
    return child;
  };
  try {
    const orphan = await worker('2828');
    const live = await worker('3001');
    await hopCheck('orphan-worker', async () => {
      const started = Date.now();
      const first = probe(runner, ['3001']);
      const stopped = first.orphansStopped ?? [];
      within(stopped.includes(orphan.pid), 'the idle probe stops the worker its controller no longer names',
        { ms: first.ms, measured: `probe stopped [${stopped.join(', ')}]: ${first.reason}` });
      assert.ok(!stopped.includes(live.pid), 'the controller\'s live job is never signalled');
      await waitUntil(() => gone(orphan.pid), 'the orphan worker exits on its SIGTERM', 10_000, 50);
      const ms = Date.now() - started;
      assert.ok(!gone(live.pid), 'the live job still runs');
      const second = probe(runner, ['3001']);
      within(second.idle === true, 'the next probe proves the runner idle beside the live job', { ms, measured: `second probe: ${second.reason}` });
      return { ms, measured: `orphan stopped and gone in ${ms} ms; next probe idle (${second.reason})` };
    });
  } finally {
    // The live job's worker is this harness's child too; it ends with the harness.
    for (const child of workers) child.kill('SIGKILL');
    pool.close();
  }
});
