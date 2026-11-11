/** @pullboard-test-input source-tree */
/** A pulled runner job submits, serves its NEED, waits with no controller process and finishes through the unchanged result check [C7,#5465]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { executionServicesSource } from '../../../tests/fixtures/gate/execution.js';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** A runner agent in miniature: runs a queued job's own command with its input file, serves the pack the job asks for, writes its files. */
function miniAgentSource(ssh, runnerHome) {
  return `
    import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const runnerRoot = join(${JSON.stringify(runnerHome)}, '.pullboard-runner');
    const home = process.env.PULLBOARD_MACHINE_HOME;
    export function miniAgent(onWait) {
      return async function waitRunnerJob({ id, check, onNeed, onReady, signal }) {
        const job = JSON.parse(readFileSync(join(home, 'runner-jobs', id + '.json'), 'utf8'));
        onWait(job);
        const queued = join(runnerRoot, 'queue', id), running = join(runnerRoot, 'running', id), done = join(runnerRoot, 'done', id);
        mkdirSync(join(runnerRoot, 'running'), { recursive: true }); mkdirSync(join(runnerRoot, 'done'), { recursive: true });
        renameSync(queued, running);
        const command = readFileSync(join(running, 'command'), 'utf8').trimEnd();
        const child = spawn(${JSON.stringify(ssh)}, [...job.args.slice(0, -2), job.args.at(-2), command], { stdio: ['pipe', 'pipe', 'pipe'] });
        createReadStream(join(running, 'input')).pipe(child.stdin, { end: false });
        const out = [], err = []; let control = '', needSeen = false, readySeen = false, receipt = false;
        child.stdout.on('data', chunk => out.push(chunk));
        child.stderr.on('data', chunk => {
          err.push(chunk); control += chunk.toString('utf8');
          let newline;
          while ((newline = control.indexOf('\\n')) >= 0) {
            const line = control.slice(0, newline); control = control.slice(newline + 1);
            if (line === 'PULLBOARD_RUNNER_READY ' + id && !readySeen) { readySeen = true; onReady(); }
            if (line.startsWith('PULLBOARD_RUNNER_RESULT ' + id + ' ')) receipt = true;
            if (line.startsWith('PULLBOARD_RUNNER_NEED ' + id + ' ') && !needSeen) {
              needSeen = true; onNeed(line.slice(('PULLBOARD_RUNNER_NEED ' + id + ' ').length));
              const feed = setInterval(() => {
                if (!existsSync(join(running, 'source.pack.ready'))) return;
                clearInterval(feed); createReadStream(join(running, 'source.pack')).pipe(child.stdin);
              }, 50);
            }
          }
        });
        const ended = new Promise(resolve => child.once('close', (code, killed) => resolve({ code, signal: killed })));
        let stopped = null;
        const tick = setInterval(() => { const found = check(); if (found && !stopped) { stopped = found; child.kill('SIGTERM'); } }, 200);
        signal?.addEventListener('abort', () => { stopped ??= { reason: 'canceled' }; child.kill('SIGTERM'); }, { once: true });
        const exit = await ended;
        clearInterval(tick);
        writeFileSync(join(running, 'out.bin'), Buffer.concat(out)); writeFileSync(join(running, 'control.log'), Buffer.concat(err));
        renameSync(running, done);
        return stopped ?? { reason: receipt ? 'result' : 'ssh-exit', exit };
      };
    }
  `;
}

test('a pulled job returns the controller path\'s result and leaves no controller process while it waits [C7,#5465]', t => {
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
  const agent = join(box.dir, 'agent.mjs');
  writeFileSync(agent, miniAgentSource(join(bin, 'ssh'), home));
  const script = `
    import { readdirSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    import { withGateSlot } from ${JSON.stringify(gate)};
    import { runPulled } from ${JSON.stringify(runners)};
    import { miniAgent } from ${JSON.stringify(pathToFileURL(agent).href)};
    ${executionServicesSource(gate)}
    const root = ${JSON.stringify(box.repo)};
    writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
      gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnersOnly: true, runnerWaitMs: 30000 },
      runners: [{ host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 1 }] }));
    const command = 'printf job-finished; sleep 3; exit 3';
    const shaped = result => ({ exitCode: result.exitCode, isGreen: result.isGreen, output: String(result.output ?? ''), kind: result.executionReceipt?.kind, runner: result.executionRunner });
    const settle = promise => promise.catch(error => ({ refused: error.code, message: error.message }));
    const viaController = await withGateSlot(root, lease => settle(lease.executionServices.runners.runOnRunnerAsync(root, command, {
      runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata })),
      { executionServices, remote: true, runnerOnly: true, item: '1', kind: 'pull-control', onWait() {} });
    let counts = [], waiting = false;
    const sampler = setInterval(() => {
      if (!waiting) return;
      try { counts.push(execFileSync('pgrep', ['-P', String(process.pid), '-f', 'pullboard-runner-controller'], { encoding: 'utf8' }).split(String.fromCharCode(10)).filter(Boolean).length); }
      catch { counts.push(0); }
    }, 250);
    const viaPull = await withGateSlot(root, lease => settle(runPulled(root, command, {
      runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, metadata: lease.runMetadata },
      { waitRunnerJob: miniAgent(() => { waiting = true; }) })),
      { executionServices, remote: true, runnerOnly: true, item: '1', kind: 'pull-job', onWait() {} });
    clearInterval(sampler);
    const left = dir => { try { return readdirSync(dir); } catch { return []; } };
    console.log(JSON.stringify({ viaController: shaped(viaController), viaPull: viaPull.refused ? viaPull : shaped(viaPull), counts,
      records: left(join(process.env.PULLBOARD_MACHINE_HOME, 'runner-jobs')), runnerLeft: ['queue', 'running', 'done'].map(name => left(join(${JSON.stringify(home)}, '.pullboard-runner', name)).length) }));
  `;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const actual = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(actual.viaController.exitCode, 3, `the control run finished: ${JSON.stringify(actual.viaController)}`);
  assert.deepEqual(actual.viaPull, actual.viaController, 'the pulled job returns the controller path\'s result shape');
  assert.ok(actual.counts.length >= 4, 'the wait was sampled');
  assert.equal(Math.max(...actual.counts), 0, 'no controller process lives while a pulled job waits');
  assert.deepEqual(actual.records, [], 'the finished job\'s record is removed');
  assert.deepEqual(actual.runnerLeft, [0, 0, 0], 'the runner forgets the finished job');
});
