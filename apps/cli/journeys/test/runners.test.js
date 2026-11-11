/** The test command honors machine runner-only policy even with an idle local slot [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';
import {
  listResources,
  takeResource,
} from '../../../../packages/resources/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Keep one real runner reservation busy in a private machine while leaving its local slot idle. */
async function withBusyRunner(action) {
  const box = e2e.project('node apps/cli/src/io/run/tests.js', e2e.sandbox(), { withWorktree: false });
  const marker = join(box.dir, 'executed');
  mkdirSync(join(box.repo, 'test'));
  mkdirSync(join(box.repo, 'bin'));
  mkdirSync(join(box.repo, 'packages/gate/src/io/run'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/src/io/run/tests.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'suite');\n`);
  writeFileSync(join(box.repo, 'test/ordinary.test.js'),
    `const {test}=require('node:test');test('ordinary case',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'named'));\n`);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'env -u NODE_TEST_CONTEXT node --test' }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: committed ordinary test and full runner');
  const runner = { host: 'fixture-busy-runner', slots: 1, browser: 1, gui: true };
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const settings = { gateSlots: 1, browserSlots: 1, runners: [runner],
    gate: { runnersOnly: true, runnersFirst: false, runnerWaitMs: 80, memoryFloorMB: 0 } }; // budget: bounded private admission refusal, never a production timeout override.
  writeFileSync(settingsFile, JSON.stringify(settings));
  const keys = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = box.env[key];
  let held;
  try {
    held = await takeResource({ name: 'gate', scope: 'machine', root: box.repo, capacity: 1,
      browserCapacityProvider: () => 1, browser: true, remote: true, runnerOnly: true,
      runnerProvider: () => [runner], agent: 'busy-runner-control' });
    assert.equal(held.runner.host, runner.host, 'the sole remote slot is really occupied');
    /** Release this fixture's own remote reservation before a real transport control runs. */
    const releaseRunner = () => { held?.release(); held = null; };
    await action({ ...box, marker, settingsFile, settings, releaseRunner });
    const pool = listResources({ scope: 'machine', root: box.repo });
    assert.equal(pool.find(resource => resource.name === 'gate').line.length, 0, 'the test admission leaves no waiter');
    assert.equal(pool.find(resource => resource.name === 'gate').holders.length, 0, 'no local test holder survives');
  } finally {
    held?.release();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
}

test('runner-only named and affected tests refuse a busy runner without starting idle local capacity [C7]', async () => {
  await withBusyRunner(box => {
    for (const args of [['test/ordinary.test.js'], ['--affected']]) {
      const result = box.run(box.repo, 'test', ...args, '--json');
      assert.notEqual(result.code, 0, result.err);
      const refusal = JSON.parse(result.out).error;
      assert.equal(refusal.code, 'RUNNER_WAIT_DEADLINE', 'the registered runner is busy rather than silently replaced locally');
      assert.match(result.err, /gate\.runnersOnly/u, 'the public refusal/wait identifies the governing setting');
      assert.match(refusal.message, /fixture-busy-runner: busy/u);
      assert.equal(existsSync(box.marker), false, 'no ordinary named or full-fallback test body ran locally');
    }
  });
});

test('turning runner-only off retains local execution while the same runner is busy [C7]', async () => {
  await withBusyRunner(box => {
    writeFileSync(box.settingsFile, JSON.stringify({ ...box.settings, gate: { ...box.settings.gate, runnersOnly: false } }));
    const result = box.run(box.repo, 'test', 'test/ordinary.test.js', '--json');
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).runner, 'this machine');
    assert.equal(readFileSync(box.marker, 'utf8'), 'named', 'the ordinary test body actually ran');
    assert.doesNotMatch(result.err, /gate\.runnersOnly is on/u);
  });
});

test('a direct full suite also honors runner-only without a CPU-load declaration [C7]', async () => {
  await withBusyRunner(box => {
    const module = new URL('../../../../packages/gate/index.js', import.meta.url).href;
    const gate = new URL('../../../../packages/gate/index.js', import.meta.url).href;
    const source = `import {runFullSuite} from ${JSON.stringify(module)};
${executionServicesSource(gate)}
try { await runFullSuite(process.cwd(), ${JSON.stringify(join(box.repo, 'apps/cli/src/io/run/tests.js'))}, executionServices); process.exitCode=9; }
catch(error) { console.error(error.message); process.exitCode=error.code==='RUNNER_WAIT_DEADLINE'?0:8; }`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source],
      { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 15_000 }); // budget: bound a missing private admission deadline; not a speed target.
    assert.equal(result.status, 0, result.context);
    assert.match(result.stderr, /gate\.runnersOnly/u);
    assert.match(result.stderr, /fixture-busy-runner: busy/u);
    assert.equal(existsSync(box.marker), false, 'the suite command never starts locally');
  });
});

test('a remote red test keeps main comparisons runner-only under the same captured deadline [C7]', async () => {
  await withBusyRunner(box => {
    box.releaseRunner();
    const paths = Object.fromEntries(['ssh-bin', 'worker', 'remote-home', 'remote-machine'].map(name => [name, join(box.dir, name)]));
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
    const requests = join(box.dir, 'ssh-requests.jsonl');
    installSshStandIn({ bin: paths['ssh-bin'], worker: paths.worker, home: paths['remote-home'], machineHome: paths['remote-machine'], requests });
    box.env.PATH = paths['ssh-bin'] + ':' + box.env.PATH;
    const runner = { host: HOST, slots: 1, browser: 1, gui: true };
    const settings = { ...box.settings, runners: [runner],
      gate: { ...box.settings.gate, runnerWaitMs: 30_000 } }; // budget: one private cutoff shared by real SSH startup and the deliberately blocked main comparison.
    writeFileSync(box.settingsFile, JSON.stringify(settings));
    // Main's copy passes and writes "named". The snapshot's red body instead records its actual remote cwd.
    writeFileSync(join(box.repo, 'test/ordinary.test.js'),
      `const {test}=require('node:test');test('remote red case',()=>{require('node:fs').appendFileSync(${JSON.stringify(box.marker)},process.cwd()+'\\n');throw Error('deliberate red');});\n`);
    const runModule = new URL('../../../../packages/gate/index.js', import.meta.url).href;
    const mainModule = new URL('../../../../packages/landing/index.js', import.meta.url).href;
    const signaturesModule = new URL('../../../../packages/landing/index.js', import.meta.url).href;
    const resourcesModule = new URL('../../../../packages/resources/index.js', import.meta.url).href;
    const gateModule = new URL('../../../../packages/gate/index.js', import.meta.url).href;
    const driver = `import {readFileSync} from 'node:fs';
import {runTestFiles} from ${JSON.stringify(runModule)};
import {compareMainFailures,withMainCheckout} from ${JSON.stringify(mainModule)};
import {failureSignatures} from ${JSON.stringify(signaturesModule)};
import {takeResource} from ${JSON.stringify(resourcesModule)};
${executionServicesSource(gateModule)}
const config=JSON.parse(readFileSync('pullboard.json','utf8'));
const result=await runTestFiles(process.cwd(),config,['test/ordinary.test.js'],{compareMain:true,executionServices,withMainCheckout,failureSignatures,
  compareMainFailures:async (...args)=>{
    const held=await takeResource({name:'gate',scope:'machine',root:process.cwd(),capacity:1,
      browserCapacityProvider:()=>1,browser:true,remote:true,runnerOnly:true,
      runnerProvider:()=>[${JSON.stringify(runner)}],agent:'busy-comparison-control'});
    try { return await compareMainFailures(...args); } finally { held.release(); }
  }});
console.log(JSON.stringify(result));`;
    const ran = runFixtureChild(process.execPath, ['--input-type=module', '-e', driver],
      { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000 }); // budget: one private SSH startup and its bounded comparison, never an unbounded queue.
    assert.equal(ran.status, 0, ran.context);
    const result = JSON.parse(ran.stdout);
    assert.equal(result.green, false, 'the real remote primary test failed');
    assert.equal(result.runner, HOST, 'the primary body ran through the actual stand-in SSH worker');
    assert.deepEqual(result.known, [], 'a local passing main control was not silently executed');
    assert.match(result.mainUnavailable, /RUNNER_WAIT_DEADLINE/u);
    assert.match(result.mainUnavailable, /fixture-host: busy/u);
    assert.notEqual(readFileSync(box.marker, 'utf8'), 'named', 'main never overwrites the marker from its local test body');
    const calls = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.workerStarted).length, 1, 'only the primary test dispatched a runner job');
  });
});
