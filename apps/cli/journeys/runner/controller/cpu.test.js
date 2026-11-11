/** @pullboard-test-input source-tree */
/** A controller waiting on its remote job sleeps on events, uses almost no CPU, and still reports the job's result [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { executionServicesSource } from '../../../tests/fixtures/gate/execution.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** Controller CPU seconds as `ps` reports them, `[[dd-]hh:]mm:ss.cc`; null once the process is gone. */
function cpuSeconds(pid) {
  let text;
  try { text = execFileSync('/bin/ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return null; }
  if (!text) return null;
  const [clock, days] = text.includes('-') ? [text.split('-')[1], Number(text.split('-')[0])] : [text, 0];
  return clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + days * 86400;
}

test('a controller for a 30 s remote job uses under 0.3 s of CPU and still reports the job\'s result and exit code [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Controller idle witness', '--specs', 'G1', '--criterion', 'a waiting controller idles', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const bin = join(box.dir, 'ssh-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'runner-home'), machineHome = join(home, '.pullboard');
  const requests = join(box.dir, 'requests.jsonl'), samples = join(box.dir, 'cpu-samples.jsonl');
  const gitBin = join(box.dir, 'git-bin'), gitCalls = join(box.dir, 'git-calls.log');
  for (const directory of [bin, worker, home, machineHome, gitBin, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  // Each Git process names the process that started it, so the wait can be checked for observation by polling.
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(gitBin, 'git'), `#!/bin/sh\necho "$PPID $*" >> ${JSON.stringify(gitCalls)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(gitBin, 'git'), 0o755);
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  // The parent samples the controller's CPU each second from outside it; the controller itself has no timer to wake.
  const script = `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    import { withGateSlot } from ${JSON.stringify(gate)};
    ${executionServicesSource(gate)}
    const cpuSeconds = ${cpuSeconds.toString()};
    const root = ${JSON.stringify(box.repo)}, requests = ${JSON.stringify(requests)}, samples = ${JSON.stringify(samples)}, gitCalls = ${JSON.stringify(gitCalls)};
    const gitBy = pids => existsSync(gitCalls) ? readFileSync(gitCalls, 'utf8').split(String.fromCharCode(10)).filter(line => pids.includes(Number(line.split(' ')[0]))).length : 0;
    writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
      gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnersOnly: true, runnerWaitMs: 30000, runnerDispatch: 'controller' },
      runners: [{ host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 1 }]
    }));
    let done = false;
    const running = withGateSlot(root, async lease => {
      try { return await lease.executionServices.runners.runOnRunnerAsync(root, 'printf job-finished; sleep 30; exit 3', {
        runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata }); }
      catch (error) { return { refused: error.code, message: error.message }; }
    }, { executionServices, remote: true, runnerOnly: true, item: '1', kind: 'idle-fixture', onWait() {} })
      .catch(error => ({ refused: error.code, message: error.message })).finally(() => { done = true; });
    const boot = Date.now() + 20000;
    while (!done && !(existsSync(requests + '.phases') && readFileSync(requests + '.phases', 'utf8').includes('dispatched'))) {
      if (Date.now() > boot) throw new Error('the controller never dispatched its owned SSH child');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // Only this process's own children: a busy machine lists more processes than one ps read should hold.
    const controllers = execFileSync('pgrep', ['-P', String(process.pid), '-f', 'pullboard-runner-controller'], { encoding: 'utf8' })
      .split(String.fromCharCode(10)).filter(Boolean).map(Number);
    // Startup and dispatch are over; from here the controller only waits on the remote job.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const started = Date.now(), gitBefore = gitBy(controllers);
    let gitDuring = 0;
    while (!done) {
      gitDuring = gitBy(controllers) - gitBefore;
      for (const pid of controllers) {
        const cpu = cpuSeconds(pid);
        if (cpu !== null) appendFileSync(samples, JSON.stringify({ pid, at: Date.now() - started, cpu }) + String.fromCharCode(10));
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const result = await running;
    console.log(JSON.stringify({ controllers, gitDuring, gitLines: existsSync(gitCalls) ? readFileSync(gitCalls, 'utf8').split(String.fromCharCode(10)).filter(line => controllers.includes(Number(line.split(' ')[0]))).slice(-12) : [], waitedMs: Date.now() - started, result: { exitCode: result.exitCode, isGreen: result.isGreen, output: String(result.output ?? ''), refused: result.refused, message: result.message } }));`;
  const env = { ...box.env, PATH: `${gitBin}:${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.dir, env, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(actual.result.refused, undefined, `the job ran to completion: ${actual.result.message}`);
  assert.equal(actual.result.exitCode, 3, 'the controller reports the remote job\'s own exit code');
  assert.equal(actual.result.isGreen, false, 'a nonzero exit is a red result');
  assert.match(actual.result.output, /job-finished/u, 'the controller reports the remote job\'s output');
  assert.equal(actual.controllers.length, 1, 'exactly one controller waits on the remote job');
  const rows = readFileSync(samples, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(rows.length >= 2, 'the controller was sampled while it waited');
  const waited = rows.at(-1).at - rows[0].at, used = rows.at(-1).cpu - rows[0].cpu;
  t.diagnostic(`controller CPU while waiting: ${used.toFixed(2)} s over ${waited} ms`);
  assert.ok(waited >= 25_000, `the controller was watched for ${waited} ms of the 30 s job`);
  assert.equal(actual.gitDuring, 0, JSON.stringify(actual.gitLines) + 'the waiting controller wakes on events, so it starts no Git process to observe its item or source');
  assert.ok(used < 0.3, `a controller waiting ${waited} ms on its remote job used ${used.toFixed(2)} s of CPU`);
});
