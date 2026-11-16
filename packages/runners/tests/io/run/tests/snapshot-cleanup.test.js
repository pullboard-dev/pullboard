/** @pullboard-test-input source-cell runners */
/** The production test runner reports cleanup it could not verify without failing the tests; split from snapshot.test.js to hold each file under 60 s [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { waitForFixtureProcessDrain } from '../../../fixtures/landing-run.js';
import { fixtureProcessIdentity } from '../../../fixtures/landing-run.js';
import { signalFixtureProcess } from '../../../fixtures/landing-run.js';
import { waitForFixtureMarker } from '../../../fixtures/landing-run.js';
import { makeShardFixture } from '../../../fixtures/landing-run.js';
import { runShardWithPreload } from '../../../fixtures/landing-run.js';

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
  const result = runShardWithPreload(fixture, 'test/spawn-snapshot.test.js', { preload, waitMs: 1000, timeout: 25000 }); // the injected failure leaves one wait, and the case proves the outcome, not the wait
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
  const result = runShardWithPreload(fixture, 'test/worker-unverified.test.js', { preload, waitMs: 1000, timeout: 45000 }); // the injected failure leaves one wait, and the case proves the outcome, not the wait
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
