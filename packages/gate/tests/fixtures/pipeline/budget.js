/**
 * Repro, #3563 and #3832 (8 Nov): a gate ran doctrine for 177 s on its lease, then dispatched with the lease's queue
 * deadline long past, so its READY budget was 0 and every batch was cut off before its worker could answer; 15 of 36
 * gates logged a missed READY on a healthy runner. The invariants: with a free slot, runner admission takes under 1 s;
 * a dispatch after a long analysis still gets a full startup budget and reaches READY on its first attempt, and the
 * healthy runner is never held [C7]. The READY check fails on 8f7c4c7024^; passes after it and 6b0cf2f355.
 *
 * The runner is the repo's local SSH stand-in, which runs the real pinned worker capsule in a second private machine
 * home; no configured host is contacted.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  from,
  guardProcesses,
  hopCheck,
  track,
  within,
} from './kit.js';

const { createE2eHelpers } = await from('apps/cli/tests/fixtures/e2e.js');
const { fixtureMachineSettings } = await from('apps/cli/tests/fixtures/testkit.js');
const { HOST, installSshStandIn } = await from('apps/cli/tests/fixtures/runner/ssh.js');
const { runFixtureChild } = await from('apps/cli/tests/fixtures/child.js');
const { executionServicesSource } = await from('apps/cli/tests/fixtures/gate/execution.js');

/** Runner admission with a free slot, from the brief: under a second. */
const ADMISSION_MS = 1_000;
/** The stand-in's boot budget: under load its own Node process needs seconds to start (see runner-transport-lost). */
const STAND_IN_BOOT_MS = 8_000;

guardProcesses();

test('runner admission is quick and a dispatch after a long analysis reaches READY first time [C7]', { timeout: 180_000 }, async t => {
  const e2e = createE2eHelpers();
  const box = e2e.project('true');
  track(box.dir);
  const bin = join(box.dir, 'transport-bin'), worker = join(box.dir, 'worker'), home = join(box.dir, 'worker-home');
  for (const folder of [bin, worker, home, join(home, '.pullboard'), box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests: join(box.dir, 'requests.jsonl'),
    starts: join(box.dir, 'starts.jsonl'), nodeCommand: process.execPath });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: HOST, slots: 1, browser: 0, node: process.execPath };
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnerWaitMs: STAND_IN_BOOT_MS }, runners: [runner] });
  const gate = pathToFileURL(join(ROOT, 'packages/gate/index.js')).href;
  const source = `import { withGateSlot, runProfiledShellAsync } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
    import { DatabaseSync } from 'node:sqlite';
    const attempts = [];
    const started = performance.now();
    let admittedMs = null, dispatchMs = null;
    let run = null, refused = null;
    try { run = await withGateSlot(process.cwd(), lease => {
      admittedMs ??= performance.now() - started;
      attempts.push(lease.runner.host);
      // The lease's queue deadline already passed, as after a gate's 177 s doctrine phase on that lease (#3563).
      lease.runnerWaitDeadline = Date.now() - 1;
      const dispatched = performance.now();
      return runProfiledShellAsync(process.cwd(), 'node -e "console.log(\\'HOP_READY_EXECUTED\\')"', { gateLease: lease })
        .finally(() => { dispatchMs = performance.now() - dispatched; });
    }, { executionServices, remote: true, runnerOnly: true, onWait() {} }); }
    catch (error) { refused = error.code ?? error.name; }
    const db = new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME + '/resources.sqlite', { readOnly: true });
    const held = db.prepare('SELECT host, detail FROM runner_unavailable').all();
    db.close();
    console.log(JSON.stringify({ green: run?.isGreen === true, executed: /HOP_READY_EXECUTED/u.test(run?.output ?? ''), refused, attempts, held, admittedMs, dispatchMs }));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 150_000 });
  t.after(e2e.cleanup);
  if (result.status !== 0) throw new Error(`gate child exited ${result.status}: ${String(result.stderr || result.failure).slice(0, 800)}`);
  const seen = JSON.parse(result.stdout.trim().split('\n').at(-1));

  await t.test('runner-admission', () => hopCheck('runner-admission', async () => {
    const measured = { ms: seen.admittedMs, measured: `admitted to ${runner.host} in ${Math.round(seen.admittedMs)} ms with its one slot free` };
    within(seen.admittedMs !== null && seen.admittedMs < ADMISSION_MS, `runner admission with a free slot takes under ${ADMISSION_MS} ms`, measured);
    return measured;
  }));
  await t.test('ready-budget', () => hopCheck('ready-budget', async () => {
    const measured = { ms: seen.dispatchMs, measured: `${seen.attempts.length} dispatch(es), ${seen.refused ? `refused ${seen.refused}` : seen.green ? 'green' : 'not green'}, ${seen.held.length} runner(s) held after a passed queue deadline` };
    within(seen.green && seen.executed && seen.attempts.length === 1 && seen.held.length === 0,
      'a dispatch after its queue deadline reaches READY on its first attempt and holds no healthy runner', measured);
    return measured;
  }));
});
