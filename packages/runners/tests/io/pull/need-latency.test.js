/** The pull waiter sees a runner's need, ready and done steps within 1 s of the runner writing them, not at the 3 s mirror cadence [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { HOST } from '../../../../gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../gate/tests/fixtures/runner/ssh.js';
import { waitRunnerJob } from '../../../src/io/pull/wait.js';

test('runners.need-latency.c7-the-waiter-observes-need-within: C7: the waiter observes need within 1 s of the runner writing it, and ready and done too, on the default cadence [C7]', {
  timeout: 30_000, // budget: one waiter over the ssh stand-in against a real runner folder, three steps each written just after a refresh.
}, async t => {
  const base = privateFixtureFiles('pbneed-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'runner'), dir = join(base, 'status'), bin = join(base, 'bin');
  for (const sub of [root, dir, bin, join(base, 'home')]) mkdirSync(sub, { recursive: true });
  const ssh = installSshStandIn({ bin, worker: base, home: join(base, 'home'), machineHome: join(base, 'machine'), requests: join(base, 'requests') });
  const queued = join(root, 'queue', 'j'), running = join(root, 'running', 'j'), finished = join(root, 'done', 'j');
  for (const state of ['queue', 'running', 'done']) mkdirSync(join(root, state), { recursive: true });
  mkdirSync(queued);
  writeFileSync(join(queued, 'owner.json'), JSON.stringify({ pid: process.pid }));
  const seen = {}, wrote = {}, waiters = {};
  const arrives = step => new Promise(resolve => { waiters[step] = resolve; });
  const first = arrives('look'), need = arrives('need'), ready = arrives('ready');
  const note = step => { seen[step] ??= Date.now(); waiters[step]?.(); };
  const waited = waitRunnerJob({ runner: { host: HOST, root }, id: 'j', mirror: { dir, ssh },
    observe: () => { note('look'); return null; }, onNeed: async () => note('need'), onReady: () => note('ready') });
  await first; // a refresh has just been taken, so each step below is written at the worst point of the cadence
  renameSync(queued, running); // the agent claims the job
  wrote.need = Date.now(); writeFileSync(join(running, 'control.log'), 'PULLBOARD_RUNNER_NEED j QUJD\n');
  await need;
  wrote.ready = Date.now(); appendFileSync(join(running, 'control.log'), 'PULLBOARD_RUNNER_READY j\n');
  await ready;
  wrote.done = Date.now(); appendFileSync(join(running, 'control.log'), 'PULLBOARD_RUNNER_RESULT j e30=\n');
  renameSync(running, finished);
  const end = await waited;
  note('done');
  const lag = step => seen[step] - wrote[step];
  process.stdout.write(`step lag ms: need ${lag('need')}, ready ${lag('ready')}, done ${lag('done')}\n`);
  assert.equal(end.end, 'result');
  for (const [step, limit] of [['need', 1_000], ['ready', 1_000], ['done', 1_500]]) assert.ok(lag(step) <= limit, `the waiter saw ${step} ${lag(step)} ms after the runner wrote it, over the ${limit} ms limit`);
});
