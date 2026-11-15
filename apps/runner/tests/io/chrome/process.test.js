/** @pullboard-test-input packages/runners/index.js */
/** A foreign process must neither be signalled nor take a healthy runner out of service [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDescendantTracker } from '../../../index.js';
import { awaitNestedRun } from '../../../../../packages/gate/index.js';
import { runFixtureChildAsync } from '../../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../cli/tests/fixtures/child.js';
import { HOST } from '../../../../cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../cli/tests/fixtures/runner/ssh.js';
import { shellQuote } from '../../../../cli/tests/fixtures/runner/ssh.js';

/** A scripted census avoids sending signals to host processes when testing ownership boundaries. */
function row(pid, ppid) {
  return { pid, ppid, pgid: pid, started: 'Tue Nov 3 12:00:00 2026', state: 'S', command: 'fixture' };
}

for (const outcome of ['foreign', 'unreadable', 'owned', 'later-foreign']) {
  test(`exact birth evidence distinguishes ${outcome} after reparenting [C7]`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-foreign-custody-'));
    const self = 9_300_001, parent = 9_300_010, child = 9_300_020;
    let rows = new Map([[self, row(self, 1)]]), start = outcome === 'foreign' ? 'mac:2.000000' : outcome === 'owned' ? 'mac:1.000000' : '';
    const signals = [];
    const tracker = createDescendantTracker(directory, { selfPid: self, census: () => rows, startOf: () => start,
      kill(pid, signal) { signals.push({ pid, signal }); rows.delete(Math.abs(pid)); } });
    tracker.stopMonitoring();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'child-journal', `children-${parent}.jsonl`), [
      { type: 'boot', pid: parent, ppid: self, instance: 'private-job-parent' },
      { type: 'spawn', pid: child, ppid: parent, instance: 'private-job-parent', commandSha256: 'a'.repeat(64), start: 'mac:1.000000' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    rows.set(child, row(child, 1));
    tracker.observe();
    if (outcome === 'unreadable' || outcome === 'later-foreign') {
      assert.deepEqual(tracker.cleanupState().pending.map(value => value.pid), [child], 'unreadable identity remains uncertain');
      assert.deepEqual(signals, []);
      if (outcome === 'unreadable') return;
      start = 'mac:2.000000';
      tracker.observe();
    }
    await tracker.stopDescendants();
    await tracker.verifyAfterGroups();
    assert.deepEqual(tracker.cleanupState().pending, []);
    assert.deepEqual(signals, outcome === 'owned' ? [{ pid: -child, signal: 'SIGTERM' }] : [], 'only the exact recorded child is stopped');
  });
}

test('an unrelated process started during a real job survives and the same runner accepts its next job [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-foreign-runner-'));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { PATH: `${paths.bin}:${process.env.PATH}`, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Custody fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Custody fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: paths.repo, env });
  writeFileSync(join(paths.repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(paths.repo, 'tracked.txt'), 'private runner source\n');
  runFixtureGit(['add', '-A'], { cwd: paths.repo, env });
  runFixtureGit(['commit', '-qm', 'test: private runner source'], { cwd: paths.repo, env });
  writeFileSync(join(paths.bin, 'package.json'), JSON.stringify({ type: 'module' }));
  const requests = join(directory, 'requests.jsonl');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome, machineHome: paths.remoteMachine, requests });
  const ready = join(directory, 'ready.json'), release = join(directory, 'release');
  const job = `const fs=require('node:fs');
const watcher=fs.watch(${JSON.stringify(directory)},()=>{if(fs.existsSync(${JSON.stringify(release)}))watcher.close();});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,instance:process.env.PULLBOARD_RUNNER_INSTANCE,preload:process.env.PULLBOARD_RUNNER_PRELOAD}));`;
  const script = `
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOnRunnerAsync} from ${JSON.stringify(new URL('../../../../../packages/runners/index.js', import.meta.url).href)};
const runner={host:${JSON.stringify(HOST)},slots:1,browser:0};
const ready=${JSON.stringify(ready)},release=${JSON.stringify(release)};
// The private job is held on an observable filesystem handshake, never a guessed time margin.
const readyWatcher=watch(${JSON.stringify(directory)});
const running=runOnRunnerAsync(process.cwd(),${JSON.stringify(`node -e ${shellQuote(job)}`)},{runner,metadata:{item:'fixture',kind:'remote-command'}});
const readiness=(async()=>{while(!existsSync(ready))await once(readyWatcher,'change');})();
try {await Promise.race([readiness,running.then(()=>{throw new Error('job exited before readiness');})]);}
finally {readyWatcher.close();}
const info=JSON.parse(readFileSync(ready,'utf8'));
// This process belongs to the controller fixture, outside the worker's process tree and private namespace.
const foreign=spawn(process.execPath,['-e','process.stdin.resume()'],{detached:true,env:{PATH:process.env.PATH},stdio:['pipe','ignore','ignore']});
const foreignClosed=once(foreign,'close');
try {
  await once(foreign,'spawn');
  assert.ok(info.instance);
  const preload=fileURLToPath(info.preload.slice('--import='.length));
  // Fault-inject the historical receipt of a dead child whose PID the foreign process reused.
  // The real worker must compare the real kernel birth, without signalling this different lifetime.
  appendFileSync(join(dirname(preload),'child-journal','children-'+info.pid+'.jsonl'),JSON.stringify({type:'spawn',pid:foreign.pid,ppid:info.pid,instance:info.instance,commandSha256:'a'.repeat(64),start:process.platform==='darwin'?'mac:1.000000':'proc:0'})+'\\n');
  writeFileSync(release,'go');
  const first=await running;
  assert.equal(first.exitCode,0,JSON.stringify(first));
  assert.equal(foreign.exitCode,null);
  assert.equal(foreign.signalCode,null);
  const second=await runOnRunnerAsync(process.cwd(),'printf next-job',{runner,metadata:{item:'fixture',kind:'remote-command'}});
  assert.equal(second.exitCode,0,JSON.stringify(second));
  assert.equal(second.output,'next-job');
  assert.equal(foreign.exitCode,null);
  const calls=readFileSync(${JSON.stringify(requests)},'utf8').trim().split('\\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(call=>call.workerStarted).length,2,'both jobs completed on the actual worker');
  process.stdout.write('two jobs completed; foreign process survived');
} finally {writeFileSync(release,'go');foreign.stdin.end();await foreignClosed;}
`;
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: paths.repo, env }));
  assert.equal(result.status, 0, result.context);
  assert.equal(result.stdout, 'two jobs completed; foreign process survived');
});
