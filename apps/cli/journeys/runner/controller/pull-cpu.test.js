/** @pullboard-test-input source-tree */
/** With gate.runnerDispatch pull, no controller process lives while a 30 s remote job waits, and the result is still reported [C7,#5465]. */
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

test('a pulled 30 s remote job waits with no controller process and still reports the job\'s result and exit code [C7,#5465]', { timeout: 170000 }, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Pull idle witness', '--specs', 'G1', '--criterion', 'a pulled wait has no controller', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const bin = join(box.dir, 'ssh-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'runner-home'), machineHome = join(home, '.pullboard');
  const requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  const script = `
    import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    import { withGateSlot } from ${JSON.stringify(gate)};
    ${executionServicesSource(gate)}
    const root = ${JSON.stringify(box.repo)};
    writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
      gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnersOnly: true, runnerWaitMs: 40000, runnerDispatch: 'pull' },
      runners: [{ host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 1 }] }));
    const running = join(${JSON.stringify(home)}, '.pullboard-runner', 'running');
    const ready = () => { try { return readdirSync(running).filter(id => { try { return readFileSync(join(running, id, 'control.log'), 'utf8').includes('PULLBOARD_RUNNER_READY'); } catch { return false; } }).length; } catch { return 0; } };
    const counts = [];
    // Once the job is READY the dispatcher only waits: no process named for the controller may be alive under it.
    const sampler = setInterval(() => {
      if (ready() < 1) return;
      try { counts.push(execFileSync('pgrep', ['-P', String(process.pid), '-f', 'pullboard-runner-controller'], { encoding: 'utf8' }).split(String.fromCharCode(10)).filter(Boolean).length); }
      catch { counts.push(0); }
    }, 500);
    const result = await withGateSlot(root, async lease => {
      try { return await lease.executionServices.runners.runOnRunnerAsync(root, 'printf job-finished; sleep 30; exit 3', {
        runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata }); }
      catch (error) { return { refused: error.code ?? error.name, message: error.message }; }
    }, { executionServices, remote: true, runnerOnly: true, item: '1', kind: 'pull-idle', onWait() {} });
    clearInterval(sampler);
    console.log(JSON.stringify({ counts, result: { exitCode: result.exitCode, isGreen: result.isGreen, output: String(result.output ?? ''), refused: result.refused, message: result.message } }));`;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8', timeout: 150000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(actual.result.refused, undefined, `the job ran to completion: ${actual.result.message}`);
  assert.equal(actual.result.exitCode, 3, 'the pulled job reports the remote job\'s own exit code');
  assert.equal(actual.result.isGreen, false, 'a nonzero exit is a red result');
  assert.match(actual.result.output, /job-finished/u, 'the pulled job reports the remote job\'s output');
  assert.ok(actual.counts.length >= 20, `the wait was sampled for most of the 30 s job: ${actual.counts.length} samples`);
  assert.equal(Math.max(...actual.counts), 0, 'no controller process lives while a pulled job waits');
});
