/**
 * Repro, #3850 (8 Nov): a test dispatcher in a private machine home swept the real checkout it was started in,
 * relaunched three real gates into its own home, and they died when the test removed it. The invariant: a dispatcher
 * from another machine home never recovers this home's gates; a gate whose driver died stays this home's, and this
 * home's own sweep retries it [C7]. Fails on 044d6c6c18^ (the dispatcher swept its working directory); passes after.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ROOT,
  gone,
  guardProcesses,
  hopCheck,
  scratch,
  survivors,
  waitUntil,
  within,
} from './kit.js';
import {
  dispatchers,
  handoffProject,
  json,
} from './project.js';

let box;
guardProcesses({ before: () => { if (box) writeFileSync(box.release, 'release\n'); } });

/**
 * Launches a dispatcher queued in a machine home: its tickets, never its log or lock files.
 *
 * @param {string} home
 * @returns {string[]}
 */
function queuedIn(home) {
  try { return readdirSync(join(home, 'handoff-queue')).filter(name => /^\d+-.+\.json$/u.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('a dispatcher from another machine home never recovers this home\'s dead gate; this home\'s sweep does [C7]', { timeout: 300_000 }, async () => {
  box = handoffProject();
  const home = box.env.PULLBOARD_MACHINE_HOME;
  const id = box.item('Dies while no dispatcher of its home runs');
  json(box.run(box.web, 'claim', String(id), '--json'));
  box.candidate(box.web, 'hold');
  json(box.run(box.web, 'submit', String(id), '--no-next', '--json'));
  const dead = await waitUntil(() => {
    const job = box.state(id).job;
    const pid = job?.state === 'running' ? box.driver(job.id)?.pid : null;
    return pid ? { job, pid } : null;
  }, 'the gate runs under its driver', 120_000, 150);
  // The home's dispatcher and the gate's driver both die, so only a sweep can find the dead gate.
  for (const { pid } of dispatchers(home)) process.kill(pid, 'SIGKILL');
  process.kill(-dead.pid, 'SIGKILL');
  await waitUntil(() => gone(dead.pid) && !dispatchers(home).length, 'the home\'s dispatcher and driver are gone', 10_000, 50);
  assert.equal(box.state(id).job.id, dead.job.id, 'the dead gate still shows its running job');

  await hopCheck('foreign-sweep', async () => {
    const other = join(await scratch('foreign-home'), 'machine-home');
    const started = Date.now();
    const foreign = spawn(process.execPath, [join(ROOT, 'apps/lib/src/io/handoff/dispatcher.js')], { cwd: join(box.repo, '.git'), stdio: 'ignore',
      env: { ...box.env, PULLBOARD_MACHINE_HOME: other } });
    let launched = 0;
    await waitUntil(() => {
      launched = Math.max(launched, queuedIn(other).length + survivors([other]).filter(entry => entry.pid !== foreign.pid).length);
      return foreign.exitCode !== null || foreign.signalCode !== null || gone(foreign.pid) || launched > 0;
    }, 'the foreign dispatcher finishes its pass', 90_000, 200);
    const ms = Date.now() - started;
    const after = box.state(id).job;
    const measured = { ms, measured: `foreign pass ${Math.round(ms / 100) / 10} s; dead gate ${after?.id === dead.job.id ? 'left to its home' : `taken (${after?.state})`}, ${launched} launch(es) in the foreign home` };
    within(launched === 0 && after?.id === dead.job.id, 'a foreign dispatcher recovers no gate of this home into its own', measured);
    return measured;
  });

  // This home's own sweep, as its sentinel runs it, retries the gate here.
  json({ ...box.run(box.repo, 'sentinel', 'run', '--health-only'), out: '{}' });
  await waitUntil(() => box.state(id).job?.id !== dead.job.id, 'this home\'s sweep retries the dead gate', 60_000, 200);
  writeFileSync(box.release, 'release\n');
  await waitUntil(() => box.state(id).item.item_status === 'submitted', 'the retried gate finishes in its own home', 180_000, 250);
});
