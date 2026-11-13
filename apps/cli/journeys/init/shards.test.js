/** @pullboard-test-input apps/cli/pullboard.js packages/gate/src/io/run/tests.js packages/kernel/index.js packages/kernel/src/logic/census.js packages/resources/index.js */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  SOURCE,
  BIN,
  HOST,
  NAMES,
  git,
  fixture,
  scenario,
} from '../../tests/fixtures/init/shards.js';

test('GUI-marked landing files use only a runner with a GUI session [C7,V4]', (t) => {
  const box = fixture({ runner: false });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const hosts = ['fixture-no-gui', 'fixture-gui'];
  for (const host of hosts) {
    const added = runFixtureChild(process.execPath, [BIN, 'runner', 'add', host, '--slots', '1', '--browser', '1', '--json'],
      { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(added.status, 0, added.context);
  }
  // These are seeded capability reports, not a claim about this test machine's desktop session.
  const selected = join(box.repo, 'test/a.test.js');
  writeFileSync(selected, '/** @pullboard-test-gui */\n' + readFileSync(selected, 'utf8'));
  git(box.repo, box.env, 'add', '.');
  git(box.repo, box.env, 'commit', '-q', '-m', 'test: GUI-marked private fixture');
  const script = `import {recordRunnerGui} from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/resources/index.js')).href)};
for(const host of ${JSON.stringify(hosts)}) recordRunnerGui(host,host==='fixture-gui');
import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
const calls = [];
const remoteRun = async (_root, _command, options) => {
  calls.push({ host: options.runner.host, gui: options.runner.gui ?? null });
  return { isGreen: true, output: '' };
};
// Actual private SQLite leases occupy both local slots, forcing the planner to choose a runner.
const result = await withGateSlot(root, () => withGateSlot(root, () => runLandingShards({ parseProcessCensus, root,
  runner: ${JSON.stringify(join(box.repo, 'apps/cli/src/io/run/tests.js'))}, files: ['./test/a.test.js'], count: 1,
  needsBrowser: async () => true, needsGui: async () => true, remoteRun, write: () => {},
}), { executionServices, remote: false, kind: 'check' }), { executionServices, remote: false, kind: 'check' });
process.stdout.write(JSON.stringify({ green: result.isGreen, calls }));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.green, true);
  assert.deepEqual(measured.calls.map(call => call.host), ['fixture-gui'], 'a GUI-marked file never runs on the first, no-GUI runner');
  assert.equal(measured.calls[0].gui, true, 'the selected runner carries its explicit GUI capability');
});

test('a GUI-marked shard waits for a local slot when runner GUI capability is unknown [C7,V4]', t => {
  const box = fixture({ runner: true });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const script = `import { recordRunnerGui } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/resources/index.js')).href)};
// This scenario seeds its capability after registration, whose real desktop probe may report true.
recordRunnerGui(${JSON.stringify(HOST)}, null);
import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
let release;
let entered;
const ready = new Promise(resolve => { entered = resolve; });
const freed = new Promise(resolve => { release = resolve; });
const result = await withGateSlot(root, async () => {
  const held = withGateSlot(root, async () => { entered(); await freed; }, { executionServices, remote: false });
  await ready;
  const timer = setTimeout(release, 250);
  try {
    return await runLandingShards({ parseProcessCensus, root, runner: ${JSON.stringify(join(box.repo, 'apps/cli/src/io/run/tests.js'))},
      files: ['./test/a.test.js'], count: 1, needsBrowser: async () => false, needsGui: async () => true,
      remoteRun: async () => { throw new Error('an unknown GUI runner must not execute this shard'); }, write: () => {} });
  } finally { clearTimeout(timer); release(); await held; }
}, { executionServices, remote: false });
process.stdout.write(JSON.stringify(result));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.isGreen, true);
  assert.equal(measured.shards[0].attempts[0].host, 'local');
});

test('a no-GUI remote parent gives its first GUI shard to a compatible local slot [C7,V4]', t => {
  const box = fixture({ runner: true });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const settingsPath = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.runners = settings.runners.map(runner => ({ ...runner, gui: false }));
  writeFileSync(settingsPath, JSON.stringify(settings));
  const script = `import { recordRunnerGui } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/resources/index.js')).href)};
// This scenario seeds its capability after registration, whose real desktop probe may report true.
recordRunnerGui(${JSON.stringify(HOST)}, false);
import assert from 'node:assert/strict';
import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
let release;
let entered;
const ready = new Promise(resolve => { entered = resolve; });
const freed = new Promise(resolve => { release = resolve; });
const result = await withGateSlot(root, async () => {
  const held = withGateSlot(root, async () => { entered(); await freed; }, { executionServices, remote: false });
  await ready;
  try {
    return await withGateSlot(root, async inherited => {
      assert.equal(inherited.runner.host, ${JSON.stringify(HOST)});
      assert.equal(inherited.runner.gui, false);
      const timer = setTimeout(release, 250);
      try { return await runLandingShards({ parseProcessCensus, root, inherited, runner: ${JSON.stringify(join(box.repo, 'apps/cli/src/io/run/tests.js'))},
        files: ['./test/a.test.js'], count: 1, needsBrowser: async () => false, needsGui: async () => true,
        remoteRun: async () => { throw new Error('a no-GUI inherited runner must not execute this shard'); }, write: () => {} }); }
      finally { clearTimeout(timer); }
    }, { executionServices });
  } finally { release(); await held; }
}, { executionServices, remote: false });
process.stdout.write(JSON.stringify(result));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.isGreen, true);
  assert.equal(measured.shards[0].attempts[0].host, 'local');
});

test('six shards land on six different runners [C7,V4]', (t) => {
  const box = fixture({ runner: false });
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const hosts = NAMES.map(name => `fixture-${name}`);
  for (const host of hosts) {
    const added = runFixtureChild(process.execPath, [BIN, 'runner', 'add', host, '--slots', '4', '--browser', '4', '--json'],
      { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(added.status, 0, added.context);
  }
  // With two or more runners the first is kept for timed checks by default; this test needs all six open to shards.
  const machineSettings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), keptSettings = JSON.parse(readFileSync(machineSettings, 'utf8'));
  writeFileSync(machineSettings, JSON.stringify({ ...keptSettings, gate: { ...keptSettings.gate, timingRunner: false } }));
  const script = `import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(SOURCE, 'packages/gate/index.js')).href)}
import { runLandingShards } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/landing/index.js')).href)};
import { parseProcessCensus } from ${JSON.stringify(pathToFileURL(join(SOURCE, 'packages/kernel/src/logic/census.js')).href)};
const root = ${JSON.stringify(box.repo)};
const calls = [];
let release;
const allStarted = new Promise(resolve => { release = resolve; });
const remoteRun = async (_root, _command, options) => {
  calls.push(options.runner.host);
  if (calls.length === 6) release();
  await allStarted;
  return { isGreen: true, output: '' };
};
// Hold the two real local slots, so all six shards must acquire actual registered runner leases.
const result = await withGateSlot(root, () => withGateSlot(root, () => runLandingShards({ parseProcessCensus, root,
  runner: ${JSON.stringify(join(box.repo, 'apps/cli/src/io/run/tests.js'))},
  files: ${JSON.stringify(NAMES.map(name => `./test/${name}.test.js`))}, count: 6, remoteRun, write: () => {},
}), { executionServices, remote: false, kind: 'check' }), { executionServices, remote: false, kind: 'check' });
process.stdout.write(JSON.stringify({ green: result.isGreen, calls }));`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.green, true);
  assert.equal(measured.calls.length, 6, 'all six shards used the registered runner admission path');
  assert.deepEqual([...new Set(measured.calls)].sort(), hosts, 'every runner gets a shard before another gets two');
});
