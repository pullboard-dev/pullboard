/** @pullboard-test-input source-tree */
/** The production test runner keeps a landing run going through process snapshot failures [C7,V4]. */
import { copyRunnerPackage } from '../../../fixtures/package.js';
import { awaitNestedPhase } from '../../../../../gate/index.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { startFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { stageFixtureTests } from '../../../fixtures/tests.js';
import { waitForFixtureProcessDrain } from '../../../fixtures/landing-run.js';
import { fixtureProcessIdentity } from '../../../fixtures/landing-run.js';
import { signalFixtureProcess } from '../../../fixtures/landing-run.js';
import { waitForFixtureIdentityDrain } from '../../../fixtures/landing-run.js';
import { waitForFixtureMarker } from '../../../fixtures/landing-run.js';
import { readFixtureJournalTail } from '../../../fixtures/landing-run.js';
import { makeShardFixture } from '../../../fixtures/landing-run.js';

test('a green landing run retries transient process snapshot timeouts [C7,V4]', async t => {
  const fixture = makeShardFixture(t);
  const ready = join(fixture.root, 'snapshot-ready');
  const sampled = join(fixture.root, 'sample-timeout');
  const drained = join(fixture.root, 'drain-timeout');
  const childReady = join(fixture.root, 'child-ready');
  const childDrained = join(fixture.root, 'child-drained');
  const childIdentity = join(fixture.root, 'child-identity.json');
  t.after(() => {
    if (existsSync(childIdentity)) signalFixtureProcess(JSON.parse(readFileSync(childIdentity, 'utf8')), 'SIGKILL');
  });
  const preload = join(fixture.root, 'snapshot-timeout.mjs');
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(fixture.runner)}) {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, options) => {
    if (command === 'ps' && args?.[0] === '-axo' && existsSync(${JSON.stringify(ready)})) {
      const duringDrain = new Error().stack.includes('at snapshot ');
      const marker = duringDrain ? ${JSON.stringify(drained)} : ${JSON.stringify(sampled)};
      if (!existsSync(marker)) {
        writeFileSync(marker, 'injected');
        const error = new Error('injected process snapshot timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
}
`);
  const childCode = `const {writeFileSync}=require('node:fs'); const {execFileSync}=require('node:child_process');
const fields=execFileSync('ps',['-p',String(process.pid),'-o','pid=,pgid=,stat=,lstart='],{encoding:'utf8'}).trim().split(/\\s+/);
writeFileSync(${JSON.stringify(childIdentity)},JSON.stringify({pid:Number(fields[0]),pgid:Number(fields[1]),state:fields[2],started:fields.slice(3).join(' ')}));
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(childDrained)},'drained');process.exit(0)});
writeFileSync(${JSON.stringify(childReady)},'ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000);`;
  writeFileSync(join(fixture.root, 'test/shard-01.test.js'), `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('green file waits for the injected observation', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached: true, stdio: 'ignore' });
  child.unref();
  const childDeadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(childReady)}) && Date.now() < childDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(${JSON.stringify(childReady)}), 'owned detached child is ready');
  writeFileSync(${JSON.stringify(ready)}, 'ready');
  const deadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(sampled)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(${JSON.stringify(sampled)}), 'the monitor snapshot timeout was injected');
  assert.equal(existsSync(${JSON.stringify(childDrained)}), false, 'a failed snapshot authorizes no signal while the test is active');
});
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/shard-01.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.ok(existsSync(sampled), 'a live monitor observation failed once');
  assert.ok(existsSync(drained), 'the final ownership census failed once and was retried');
  assert.equal(result.status, 0, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.match(result.stdout, /# fail 0/u);
  assert.ok(existsSync(childDrained), 'the owned child acknowledged cleanup after a successful census');
  assert.ok(await waitForFixtureIdentityDrain(JSON.parse(readFileSync(childIdentity, 'utf8'))), 'the owned detached child stopped before the gate returned');
});

test('a landing worker retries its startup identity snapshot timeout [C7,V4]', t => {
  const fixture = makeShardFixture(t);
  const injected = join(fixture.root, 'worker-snapshot-timeout');
  const ran = join(fixture.root, 'worker-test-ran');
  const workerTest = join(fixture.root, 'test/worker-start.test.js');
  writeFileSync(workerTest, `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('the test body runs after the worker identity retry', () => {
  const marker = JSON.parse(readFileSync(${JSON.stringify(injected)}, 'utf8'));
  const receipts = readFileSync(process.env.PULLBOARD_LANDING_WORKER_STARTS, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
  const receipt = receipts.find(row => row.type === 'worker' && row.pid === process.pid);
  assert.equal(marker.pid, process.pid, 'the timeout was injected into this test worker');
  assert.match(marker.stack, /landingWorkerIdentity/u, 'the timeout came from worker startup, not parent monitoring');
  assert.ok(receipt && receipt.file.endsWith('worker-start.test.js') && receipt.pgid && receipt.started, 'the worker recorded a fresh successful identity receipt before test execution');
  writeFileSync(${JSON.stringify(ran)}, 'ran');
});
`);
  const preload = join(fixture.root, 'worker-snapshot-timeout.mjs');
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[1] !== ${JSON.stringify(fixture.runner)}) {
  const originalSync = childProcess.execFileSync;
  const originalExec = childProcess.execFile;
  let injected = false;
  function shouldTimeout(command, args) {
    if (injected || command !== 'ps' || args?.[0] !== '-p' || args?.[1] !== String(process.pid)) return false;
    injected = true;
    writeFileSync(${JSON.stringify(injected)}, JSON.stringify({ pid: process.pid, stack: new Error().stack }));
    return true;
  }
  childProcess.execFileSync = (command, args, options) => {
    if (shouldTimeout(command, args)) { const error = new Error('injected worker process snapshot timeout'); error.code = 'ETIMEDOUT'; throw error; }
    return originalSync(command, args, options);
  };
  childProcess.execFile = (command, args, options, callback) => {
    if (shouldTimeout(command, args)) {
      const error = new Error('injected worker process snapshot timeout'); error.code = 'ETIMEDOUT';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    return originalExec(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/worker-start.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 25_000,
  });
  assert.ok(existsSync(injected), 'the first worker identity snapshot timed out');
  assert.equal(result.status, 0, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(existsSync(ran), 'the test file executed after the retry succeeded');
  assert.match(`${result.stdout ?? ''}${result.stderr ?? ''}`, /worker identity snapshot timed out; retrying before file execution/u);
  assert.match(result.stdout, /# fail 0/u);
});

test('a landing worker runs after persistent identity snapshot errors [C7,V4]', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-worker-identity-')));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../../..'), root);
  const fixtureRunner = join(root, 'apps/cli/src/io/run/tests.js');
  const workerTest = join(tests, 'worker-start.test.js');
  const preload = join(root, 'worker-snapshot-unavailable.mjs');
  const injected = join(root, 'worker-snapshot-unavailable');
  const ran = join(root, 'worker-ran.json');
  const release = join(root, 'release-worker');
  const childReady = join(root, 'owned-child-ready');
  const childTermStarted = join(root, 'owned-child-term-started');
  const childDrained = join(root, 'owned-child-drained');
  let runnerChild;
  let runnerClosed;
  let childIdentity = null;
  t.after(async () => {
    if (!existsSync(release)) writeFileSync(release, 'release');
    if (runnerChild && runnerChild.exitCode === null && runnerChild.signalCode === null) {
      const result = await Promise.race([runnerClosed,
        new Promise(resolve => setTimeout(() => resolve(null), 25000))]);
      if (!result) {
        runnerChild.kill('SIGKILL');
        await runnerClosed;
      }
    }
    if (childIdentity) {
      signalFixtureProcess(childIdentity, 'SIGTERM');
      await waitForFixtureIdentityDrain(childIdentity);
    }
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(workerTest, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('the body runs and its detached child remains owned', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(childTermStarted)},'term'); const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(wait);fs.writeFileSync(${JSON.stringify(childDrained)},'drained');process.exit(0)}},10)}); fs.writeFileSync(${JSON.stringify(childReady)},'ready'); setInterval(()=>{},1000);`)}], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ pid: process.pid, childPid: child.pid,
    startsPath: process.env.PULLBOARD_LANDING_WORKER_STARTS, attempt: process.env.PULLBOARD_LANDING_ATTEMPT }));
});
`);
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
if (process.argv[1]?.endsWith('/worker-start.test.js')) {
  const originalSync = childProcess.execFileSync;
  const originalExec = childProcess.execFile;
  let injections = 0;
  function failWorkerSnapshot(command, args) {
    if (command !== 'ps' || args?.[0] !== '-p' || args?.[1] !== String(process.pid)) return false;
    injections += 1;
    writeFileSync(${JSON.stringify(injected)}, JSON.stringify({ pid: process.pid, args, injections }));
    return true;
  }
  childProcess.execFileSync = (command, args, options) => {
    if (failWorkerSnapshot(command, args)) { const error = new Error('injected persistent worker ps timeout'); error.code = 'ETIMEDOUT'; throw error; }
    return originalSync(command, args, options);
  };
  childProcess.execFile = (command, args, options, callback) => {
    if (failWorkerSnapshot(command, args)) {
      const error = new Error('injected persistent worker ps timeout'); error.code = 'ETIMEDOUT';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    return originalExec(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);

  stageFixtureTests(root, ['test/worker-start.test.js']);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_LANDING_IDENTITY_WAIT_MS: '5000', // the persistent-failure waits end in 5 s, since the case proves the outcome, not the wait
    PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  runnerChild = startFixtureChild(process.execPath, [fixtureRunner, 'test/worker-start.test.js'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  runnerChild.stdout?.setEncoding('utf8').on('data', part => { output += part; });
  runnerChild.stderr?.setEncoding('utf8').on('data', part => { output += part; });
  runnerClosed = new Promise(resolve => runnerChild.once('close', (code, signal) => resolve({ code, signal })));

  await awaitNestedPhase(runnerChild, async () => {
    const bodyStarted = await Promise.race([
      waitForFixtureMarker(ran, 'the worker test body ran after its local identity census failed', 25000).then(() => true),
      runnerClosed.then(() => false),
    ]);
    assert.ok(bodyStarted, `the runner exited before evaluating the worker test body\n${output}`);
    const worker = JSON.parse(readFileSync(ran, 'utf8'));
    await waitForFixtureMarker(childReady, 'the detached child started', 5000); // budget: hang ceiling for the child-ready handshake; the marker proves readiness.
    childIdentity = fixtureProcessIdentity(worker.childPid);
    assert.ok(childIdentity, 'the detached child has a capturable identity before release');
    assert.ok(existsSync(injected), 'the preload injected persistent ps timeouts only in the worker');

    const deadline = Date.now() + 5000; // Hang ceiling only; readiness is the per-child acknowledgement below.
    let receipts = [];
    let childReceipt = null;
    let childAcknowledgement = null;
    while (Date.now() < deadline) {
      if (existsSync(worker.startsPath)) {
        receipts = readFixtureJournalTail(worker.startsPath);
        const prefix = `${basename(worker.startsPath)}.child.${worker.attempt}.${worker.pid}.`;
        const path = readdirSync(dirname(worker.startsPath)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
          .map(name => join(dirname(worker.startsPath), name)).find(name => {
            try { return JSON.parse(readFileSync(name, 'utf8')).pid === worker.childPid; } catch { return false; }
          });
        if (path && existsSync(`${path}.acked`)) {
          childReceipt = JSON.parse(readFileSync(path, 'utf8'));
          childAcknowledgement = JSON.parse(readFileSync(`${path}.acked`, 'utf8'));
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const pending = receipts.find(row => row.type === 'worker-pending' && row.pid === worker.pid);
    const bound = receipts.find(row => row.type === 'worker-bound' && row.pid === worker.pid);
    const unavailable = receipts.find(row => row.type === 'worker-identity-unavailable' && row.pid === worker.pid);
    assert.ok(pending && pending.attempt === worker.attempt && pending.file.endsWith('/test/worker-start.test.js'),
      'the worker announced its selected file before retrying its local census');
    assert.ok(bound && bound.parentPid === pending.parentPid && bound.pgid && bound.started,
      'the parent bound the live direct worker using its own fresh identity census');
    assert.ok(childReceipt && childReceipt.parentPid === worker.pid && childReceipt.spawnFile,
      'the worker published a spawn announcement while its test body was still active');
    assert.equal(childAcknowledgement?.status, 'bound', 'the parent confirmed custody before the worker could exit');
    assert.ok(childAcknowledgement?.identity?.pid === worker.childPid && childAcknowledgement.identity.pgid
      && childAcknowledgement.identity.started, 'the parent acknowledged its fresh child identity');
    assert.ok(unavailable && unavailable.code === 'ETIMEDOUT', 'the worker recorded its exhausted local snapshot retries');
    assert.ok(JSON.parse(readFileSync(injected, 'utf8')).injections > 1, 'the worker-local ps failure persisted across retries');

    await waitForFixtureMarker(childTermStarted, 'the child received cleanup only after its identity was bound', 10000); // budget: hang ceiling for the owned-child TERM handshake; the marker proves delivery.
    writeFileSync(release, 'release');
  });
  const result = await runnerClosed;
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.equal((output.match(/run-tests: worker identity unavailable \(/gu) ?? []).length, 1,
    `the worker emitted one identity-unavailable diagnostic\n${output}`);
  assert.match(output, /# fail 0/u);
  assert.ok(existsSync(childDrained), 'parent-owned cleanup drained the detached child before the gate returned');
  assert.ok(await waitForFixtureIdentityDrain(childIdentity), 'the owned child stopped before the fixture returned');
});

test('a later spawn-time ps failure names unverified cleanup [C7,V4]', t => {
  const fixture = makeShardFixture(t);
  const workerTest = join(fixture.root, 'test/spawn-snapshot.test.js');
  const injected = join(fixture.root, 'spawn-snapshot-injected.json');
  const journal = join(fixture.root, 'spawn-snapshot-journal.json');
  const preload = join(fixture.root, 'spawn-snapshot-failure.mjs');
  writeFileSync(workerTest, `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('a healthy worker completes after its spawn snapshot fails', async () => {
  const starts = process.env.PULLBOARD_LANDING_WORKER_STARTS;
  const before = readFileSync(starts, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
  assert.ok(before.some(row => row.type === 'worker' && row.pid === process.pid), 'startup identity succeeded before the injected failure');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'the fixture child drains itself without runner cleanup');
  writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ pid: process.pid, childPid: child.pid,
    rows: readFileSync(starts, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line)) }));
});
`);
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(workerTest)}) {
  const original = childProcess.execFileSync;
  let injected = false;
  childProcess.execFileSync = (command, args, options) => {
    if (!injected && command === 'ps' && (args?.[0] === '-axo' || args?.[0] === '-o')) {
      injected = true;
      writeFileSync(${JSON.stringify(injected)}, JSON.stringify({ stack: new Error().stack }));
      const error = new Error('injected later spawn snapshot failure');
      error.code = 'EIO';
      throw error;
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/spawn-snapshot.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 25000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${result.context}\n${output}`);
  assert.match(output, /# fail 0/u, 'cleanup uncertainty does not change the passing test outcome');
  assert.match(JSON.parse(readFileSync(injected, 'utf8')).stack, /landingProcessTable/u,
    'the injected failure came from the synchronous spawn census after healthy startup');
  const receipt = JSON.parse(readFileSync(journal, 'utf8'));
  const unavailable = receipt.rows.find(row => row.type === 'child-snapshot-unavailable'
    && row.parentPid === receipt.pid && row.pid === receipt.childPid && row.file === workerTest);
  assert.ok(unavailable, 'the worker publishes cleanup uncertainty before it can exit');
  assert.equal(unavailable.code, 'EIO');
  assert.equal(unavailable.reason, 'injected later spawn snapshot failure');
  assert.match(output, /cleanup for spawn-snapshot\.test\.js UNVERIFIED: EIO: injected later spawn snapshot failure; no unverified process was signaled/u,
    'the parent retains the worker failure and names the affected file and reason');
  assert.equal((output.match(/cleanup for .* UNVERIFIED/gu) ?? []).length, 1, 'cleanup uncertainty is reported once');
});

test('tests continue when worker and parent identity censuses stay unavailable [C7,V4]', async t => {
  const fixture = makeShardFixture(t);
  const workerTest = join(fixture.root, 'test/worker-unverified.test.js');
  const preload = join(fixture.root, 'persistent-census-failure.mjs');
  const workerInjected = join(fixture.root, 'worker-census-injected');
  const parentInjected = join(fixture.root, 'parent-census-injected');
  const bodyRan = join(fixture.root, 'body-ran');
  const childReady = join(fixture.root, 'unknown-child-ready');
  const childPid = join(fixture.root, 'unknown-child-pid');
  const childSignal = join(fixture.root, 'unknown-child-signaled');
  let childIdentity = null;
  t.after(async () => {
    if (!childIdentity && existsSync(childPid)) childIdentity = fixtureProcessIdentity(Number(readFileSync(childPid, 'utf8')));
    if (childIdentity) {
      signalFixtureProcess(childIdentity, 'SIGTERM');
      await waitForFixtureProcessDrain(childIdentity.pid);
    }
  });
  writeFileSync(workerTest, `import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('the selected body runs while cleanup identity is unknown', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(childSignal)},'signaled');process.exit(0)}); fs.writeFileSync(${JSON.stringify(childReady)},'ready'); setInterval(()=>{},1000);`)}], { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(childReady)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(${JSON.stringify(childReady)})) throw new Error('detached child did not start before the fixture ceiling');
  writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
  writeFileSync(${JSON.stringify(bodyRan)}, 'ran');
});
`);
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const runner = ${JSON.stringify(fixture.runner)};
const workerTest = ${JSON.stringify(workerTest)};
if (process.argv[1] === runner) {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, options) => {
    if (command === 'ps' && args?.[0] === '-axo') {
      writeFileSync(${JSON.stringify(parentInjected)}, 'injected');
      const error = new Error('injected persistent parent census failure'); error.code = 'ETIMEDOUT'; throw error;
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
} else if (process.argv[1] === workerTest) {
  const original = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    if (command === 'ps' && args?.[0] === '-p' && args?.[1] === String(process.pid)
      && args?.[3] === 'pid=,ppid=,pgid=,stat=,lstart=') {
      writeFileSync(${JSON.stringify(workerInjected)}, 'injected');
      const error = new Error('injected persistent worker census failure'); error.code = 'ETIMEDOUT';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    return original(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_LANDING_IDENTITY_WAIT_MS: '5000', // the persistent-failure waits end in 5 s, since the case proves the outcome, not the wait
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/worker-unverified.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 45000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${result.context}\n${output}`);
  assert.ok(existsSync(bodyRan), 'the selected test body ran despite persistent worker and parent census errors');
  assert.ok(existsSync(workerInjected) && existsSync(parentInjected), 'both identity census failures were injected');
  assert.match(output, /# fail 0/u, 'the gate result reflects the passing tests');
  assert.match(output, /cleanup for [^\n]*worker-unverified\.test\.js[^\n]* UNVERIFIED: ETIMEDOUT: injected persistent parent census failure; no unverified process was signaled/u,
    'the runner names uncertain cleanup without treating missing identity as a test failure');
  assert.equal((output.match(/cleanup for .* UNVERIFIED/gu) ?? []).length, 1, 'one cleanup uncertainty diagnostic is emitted');
  childIdentity = fixtureProcessIdentity(Number(readFileSync(childPid, 'utf8')));
  assert.ok(childIdentity, 'the fixture child remains alive for explicit owner cleanup');
  assert.equal(existsSync(childSignal), false, 'the runner did not signal a child it could not identify');
  signalFixtureProcess(childIdentity, 'SIGTERM');
  await waitForFixtureMarker(childSignal, 'the fixture owner cleaned up its child after the run');
  assert.ok(await waitForFixtureProcessDrain(childIdentity.pid), 'the fixture child drained after explicit owner cleanup');
});
