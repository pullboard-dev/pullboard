/** @pullboard-test-input source-tree */
/** A pulled runner job submits, serves its NEED, waits with no controller process and finishes through the unchanged result check [C7,#5465]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { executionServicesSource } from '../../../tests/fixtures/gate/execution.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

for (const count of [1, 4, 12]) test(`${count} pulled job${count === 1 ? '' : 's'} return the controller path's result and leave no controller process while waiting [C7,#5465]`, { timeout: 170000 }, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Pull witness', '--specs', 'G1', '--criterion', 'a pulled job finishes', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const bin = join(box.dir, 'ssh-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'runner-home'), machineHome = join(home, '.pullboard');
  const requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../../packages/runners/index.js')).href;
  const script = `
    import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    import { withGateSlot } from ${JSON.stringify(gate)};
    import { runPulled } from ${JSON.stringify(runners)};
    ${executionServicesSource(gate)}
    const root = ${JSON.stringify(box.repo)};
    writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
      gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnersOnly: true, runnerWaitMs: 30000 },
      runners: [{ host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: ${count}, browser: 1 }] }));
    const command = 'printf job-finished; sleep ${8 + count}; exit 3';
    const shaped = result => ({ exitCode: result.exitCode, isGreen: result.isGreen, output: String(result.output ?? ''), kind: result.executionReceipt?.kind, runner: result.executionRunner });
    const settle = promise => promise.catch(error => ({ refused: error.code, message: error.message }));
    const viaController = await withGateSlot(root, lease => settle(lease.executionServices.runners.runOnRunnerAsync(root, command, {
      runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata })),
      { executionServices, remote: true, runnerOnly: true, item: '1', kind: 'pull-control', onWait() {} });
    let counts = [], inflight = 0;
    const readyJobs = () => {
      const running = join(${JSON.stringify(home)}, '.pullboard-runner', 'running');
      try { return readdirSync(running).filter(id => { try { return readFileSync(join(running, id, 'control.log'), 'utf8').includes('PULLBOARD_RUNNER_READY'); } catch { return false; } }).length; } catch { return 0; }
    };
    const sampler = setInterval(() => {
      const waiting = readyJobs();
      if (waiting < 1 || waiting < inflight) return;
      try { counts.push(execFileSync('pgrep', ['-P', String(process.pid), '-f', 'pullboard-runner-controller'], { encoding: 'utf8' }).split(String.fromCharCode(10)).filter(Boolean).length); }
      catch { counts.push(0); }
    }, 250);
    const pulled = await Promise.all(Array.from({ length: ${count} }, (_, index) => withGateSlot(root, lease => { inflight += 1; return settle(runPulled(root, command, {
      runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata },
      {})).then(result => { inflight -= 1; return result; }); },
      { executionServices, remote: true, runnerOnly: true, item: '1', kind: 'pull-job', onWait() {} })));
    clearInterval(sampler);
    const left = dir => { try { return readdirSync(dir); } catch { return []; } };
    console.log(JSON.stringify({ viaController: shaped(viaController), viaPull: pulled.map(result => result.refused ? result : shaped(result)), counts,
      records: left(join(process.env.PULLBOARD_MACHINE_HOME, 'runner-jobs')), runnerLeft: ['queue', 'running', 'done'].map(name => left(join(${JSON.stringify(home)}, '.pullboard-runner', name)).length) }));
  `;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8', timeout: 150000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(actual.viaController.exitCode, 3, `the control run finished: ${JSON.stringify(actual.viaController)}`);
  assert.deepEqual(actual.viaPull, Array(count).fill(actual.viaController), 'every pulled job returns the controller path\'s result shape');
  assert.ok(actual.counts.length >= 20, 'the wait was sampled');
  assert.equal(Math.max(...actual.counts), 0, 'no controller process lives while a pulled job waits');
  assert.deepEqual(actual.records, [], 'the finished job\'s record is removed');
  assert.deepEqual(actual.runnerLeft, [0, 0, 0], 'the runner forgets the finished job');
});
