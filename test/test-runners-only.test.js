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
import { createE2eHelpers } from './e2e-helpers.js';
import { executionServicesSource } from './gate-execution-fixture.js';
import { runFixtureChild } from './fixture-child.js';
import {
  listResources,
  takeResource,
} from '../src/resources.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Keep one real runner reservation busy in a private machine while leaving its local slot idle. */
async function withBusyRunner(action) {
  const box = e2e.project('node bin/run-tests.js', e2e.sandbox(), { withWorktree: false });
  const marker = join(box.dir, 'executed');
  mkdirSync(join(box.repo, 'test'));
  mkdirSync(join(box.repo, 'bin'));
  writeFileSync(join(box.repo, 'bin/run-tests.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'suite');\n`);
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
    await action({ ...box, marker, settingsFile, settings });
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
      assert.match(result.err, /RUNNER_WAIT_DEADLINE/u, 'the registered runner is busy rather than silently replaced locally');
      assert.match(result.err, /gate\.runnersOnly/u, 'the public refusal/wait identifies the governing setting');
      assert.match(result.err, /fixture-busy-runner: busy/u);
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
    const module = new URL('../src/test-run.js', import.meta.url).href;
    const gate = new URL('../src/gate.js', import.meta.url).href;
    const source = `import {runFullSuite} from ${JSON.stringify(module)};
${executionServicesSource(gate)}
try { await runFullSuite(process.cwd(), ${JSON.stringify(join(box.repo, 'bin/run-tests.js'))}, executionServices); process.exitCode=9; }
catch(error) { console.error(error.message); process.exitCode=error.code==='RUNNER_WAIT_DEADLINE'?0:8; }`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source],
      { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 15_000 }); // budget: bound a missing private admission deadline; not a speed target.
    assert.equal(result.status, 0, result.context);
    assert.match(result.stderr, /gate\.runnersOnly/u);
    assert.match(result.stderr, /fixture-busy-runner: busy/u);
    assert.equal(existsSync(box.marker), false, 'the suite command never starts locally');
  });
});
