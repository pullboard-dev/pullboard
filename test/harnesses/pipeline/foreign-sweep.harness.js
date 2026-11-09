/**
 * Repro, #3850 (8 Nov): a test dispatcher in a private machine home swept the real checkout it was started in,
 * relaunched three real gates into its own home, and they died when the test removed it. The invariant: a dispatcher
 * sweeping from another machine home leaves this home's queued and running gates exactly as they were [C7]. Fails on
 * 044d6c6c18^ (the dispatcher swept its working directory); passes after it and b2ed5cf838.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, gone, guardProcesses, hopCheck, scratch, survivors, waitUntil, within } from './harness-kit.js';
import { handoffProject, json } from './handoff-project.js';

let box;
guardProcesses({ before: () => { if (box) writeFileSync(box.release, 'release\n'); } });

/**
 * Files a dispatcher queued in a machine home: tickets and launches, never its own log or lock files.
 *
 * @param {string} home
 * @returns {string[]}
 */
function queuedIn(home) {
  try { return readdirSync(join(home, 'handoff-queue')).filter(name => /^\d+-.+\.json$/u.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('a dispatcher from another machine home leaves this home\'s queued and running gates alone [C7]', { timeout: 300_000 }, async () => {
  box = handoffProject({ handoffWorkers: 1 });
  const running = box.item('Holds the only worker');
  const queued = box.item('Waits its turn');
  const second = box.seat();
  json(box.run(box.web, 'claim', String(running), '--json'));
  json(box.run(second, 'claim', String(queued), '--json'));
  box.candidate(box.web, 'hold');
  box.candidate(second, 'hold');
  json(box.run(box.web, 'submit', String(running), '--no-next', '--json'));
  await waitUntil(() => box.state(running).job?.state === 'running', 'the first gate runs', 120_000, 150);
  json(box.run(second, 'submit', String(queued), '--no-next', '--json'));
  const before = { running: box.state(running).job, queued: box.state(queued).job };
  assert.equal(before.queued.state, 'queued', 'with one worker the second gate waits in line');

  await hopCheck('foreign-sweep', async () => {
    const other = join(await scratch('foreign-home'), 'machine-home');
    const entry = join(ROOT, 'bin', 'handoff-worker-dispatcher.js');
    const started = Date.now();
    const dispatcher = spawn(process.execPath, [entry], { cwd: join(box.repo, '.git'), stdio: 'ignore',
      env: { ...box.env, PULLBOARD_MACHINE_HOME: other } });
    await waitUntil(() => dispatcher.exitCode !== null || dispatcher.signalCode !== null || gone(dispatcher.pid), 'the foreign dispatcher finishes its pass and exits', 90_000, 200);
    const ms = Date.now() - started;
    const after = { running: box.state(running).job, queued: box.state(queued).job };
    const strays = survivors([other]);
    const measured = { ms, measured: `foreign pass ${Math.round(ms / 100) / 10} s; queued ${after.queued?.state} ${after.queued?.id === before.queued.id ? 'same' : 'replaced'}, running ${after.running?.state} ${after.running?.id === before.running.id ? 'same' : 'replaced'}, ${queuedIn(other).length} launches in the foreign home` };
    within(after.queued?.id === before.queued.id && after.queued.state === 'queued', 'the queued gate keeps its job and its place', measured);
    within(after.running?.id === before.running.id && after.running.state === 'running', 'the running gate keeps its job', measured);
    within(queuedIn(other).length === 0 && strays.length === 0, 'nothing was relaunched into the foreign home', measured);
    return measured;
  });

  writeFileSync(box.release, 'release\n');
  await waitUntil(() => box.state(queued).item.item_status === 'submitted' && box.state(running).item.item_status === 'submitted',
    'both gates finish in their own home', 180_000, 250);
});
