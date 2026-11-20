/** @pullboard-test-loads apps/cli/src/io/run/tests.js packages/gate/src/io/run-tests.js packages/gate/src/io/test/isolation.js src/child-journal-preload.js packages/resources/src/io/home.js packages/config/src/io/settings.js packages/resources/index.js packages/config/src/io/main.js */
/** A test's verdict never depends on the machine it runs on: settings, resources, runners, host markers, ports [C7]. */
import { awaitNestedRun } from '../../../heavy.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { childJournalPreloadSource } from '../../../heavy.js';
import { foreignNodeOptions } from '../../../heavy.js';
import { gateMachineHome } from '../../../heavy.js';
import { gateRuntimeCaptureSource } from '../../../heavy.js';
import { runtimeCaptureSource } from '../../../../sandbox/index.js';
import { machineHome } from '../../../../resources/index.js';
import { takeResource } from '../../../../resources/index.js';
import { DEFAULT_VIEW_PORT } from '../../../../config/index.js';
import { GATE_SLOT_HELD_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../../resources/index.js';

const RUNNER = resolve(import.meta.dirname, '../../../../../apps/cli/src/io/run/tests.js');
const HOSTILE_LEASE = 'isolation-hostile-machine';
const PROBES = ['probe machine settings are the defaults', 'probe the resource pool is private',
  'probe no host marker reaches the test', 'probe the default view port is never chosen'];

/** Build a probe suite outside the repository that reads every kind of machine state a test could reach. */
function probeSuite(dir) {
  const module = (path) => JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../..', path)).href);
  const root = join(dir, 'probe');
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test/probe.test.js'), `import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machineHome } from ${module('packages/resources/index.js')};
import { loadMachineSettings } from ${module('packages/config/src/io/settings.js')};
import { listResources } from ${module('packages/resources/index.js')};
import { foreignNodeOptions } from ${module('packages/gate/index.js')};
import { defaultViewPort } from ${module('packages/config/src/io/main.js')};
import { chooseViewPort } from ${module('apps/cli/tests/fixtures/view/port.js')};
// A test that drops its machine home falls back to the account home, as view-port-fixture.js does.
delete process.env.PULLBOARD_MACHINE_HOME;
  test(${JSON.stringify(PROBES[0])}, () => {
  assert.notEqual(machineHome(), join(userInfo().homedir, '.pullboard'), 'the OS account home is never read');
  assert.ok(!machineHome().startsWith(process.env.ISOLATION_HOSTILE_HOME + '/'), 'the hostile machine is never read');
  assert.deepEqual(loadMachineSettings(), { gateSlots: 2, browserSlots: 1 });
});
  test(${JSON.stringify(PROBES[1])}, () => {
  assert.equal(listResources({ scope: 'machine' }).some((resource) => resource.name === ${JSON.stringify(HOSTILE_LEASE)}), false);
});
  test(${JSON.stringify(PROBES[2])}, () => {
  assert.equal(process.env.CI, undefined);
  assert.equal(foreignNodeOptions(process.env.NODE_OPTIONS), false);
});
  test(${JSON.stringify(PROBES[3])}, async () => {
  assert.equal(defaultViewPort(), ${DEFAULT_VIEW_PORT});
  assert.notEqual(await chooseViewPort(), ${DEFAULT_VIEW_PORT});
});
`);
  return root;
}

/** The verdict line of each probe, in order, so two runs compare test by test. */
function verdicts(stdout) {
  return PROBES.map((name) => stdout.split('\n').find((line) => /^(?:not )?ok \d+ - /u.test(line) && line.endsWith(name)) ?? `missing: ${name}`);
}

test('gate.io-test-isolation.a-test-reads-no-machine-state: a test reads no machine state outside its own private home [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-isolation-')));
  // Cleanups run last-registered first, so the hostile lease is released before its directory goes.
  const cleanups = [() => rmSync(dir, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  // The hostile machine: the slot settings a coordinator set on a development machine on 23 Oct, plus a registered runner and a held lease.
  const hostile = join(dir, 'hostile-account');
  mkdirSync(join(hostile, '.pullboard'), { recursive: true });
  writeFileSync(join(hostile, '.pullboard', 'settings.json'), `${JSON.stringify({
    gateSlots: 3, browserSlots: 3, gate: { shortSlots: 2, browserByLaunch: true },
    runners: [{ host: 'nobody@192.0.2.1', slots: 4, browser: 4 }],
  })}\n`);
  const machineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(hostile, '.pullboard');
  let leased;
  try { leased = takeResource({ name: HOSTILE_LEASE, capacity: 1, scope: 'machine', root: dir }); }
  finally { process.env.PULLBOARD_MACHINE_HOME = machineHome; }
  const lease = await leased;
  cleanups.push(() => lease.release());
  // The default view port is busy, as the person's own view keeps it; an existing listener is left alone.
  const holder = createServer();
  await new Promise((done) => { holder.once('error', done); holder.listen(DEFAULT_VIEW_PORT, '127.0.0.1', done); });
  cleanups.push(() => holder.listening ? new Promise((done) => holder.close(done)) : undefined);
  // The runner's own spawn-journal preload, exactly as an SSH runner writes it for a job.
  const preload = join(dir, 'runner', 'child-spawn-preload.mjs');
  mkdirSync(join(dir, 'runner', 'child-journal'), { recursive: true });
  writeFileSync(preload, childJournalPreloadSource(join(dir, 'runner')));
  const root = probeSuite(dir);

  const base = { ...process.env, PULLBOARD_MACHINE_HOME: join(dir, 'outer-machine'), ISOLATION_HOSTILE_HOME: hostile };
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, 'CI', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT',
    'PULLBOARD_RUNNER_PRELOAD', 'PULLBOARD_VIEW_PORT']) delete base[key];
  const plainAccount = join(dir, 'plain-account');
  mkdirSync(plainAccount);
  const plain = { ...base, PULLBOARD_ACCOUNT_HOME: plainAccount };
  const runnerImport = `--import=${pathToFileURL(preload).href}`;
  const machine = { ...base, PULLBOARD_ACCOUNT_HOME: hostile, CI: '1', NODE_OPTIONS: runnerImport,
    PULLBOARD_RUNNER_PRELOAD: runnerImport, PULLBOARD_VIEW_PORT: '4891' };

  const calm = await awaitNestedRun(runFixtureChildAsync(process.execPath, [RUNNER, 'test/probe.test.js'], { cwd: root, env: plain }));
  const busy = await awaitNestedRun(runFixtureChildAsync(process.execPath, [RUNNER, 'test/probe.test.js'], { cwd: root, env: machine }));
  assert.deepEqual(verdicts(calm.stdout), PROBES.map((name, index) => `ok ${index + 1} - ${name}`), calm.stdout + calm.stderr);
  assert.deepEqual(verdicts(busy.stdout), verdicts(calm.stdout), `hostile machine settings changed a verdict:\n${busy.stdout}${busy.stderr}`);
  assert.equal(busy.status, 0, busy.stderr);

  // The probes are a real guard: run without the private home, the same suite reads the hostile machine and fails.
  const exposed = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--test', '--test-reporter=tap', 'test/probe.test.js'], { cwd: root, env: machine }));
  assert.notEqual(exposed.status, 0, 'a test that reads the machine home fails the guard');
  const seen = verdicts(exposed.stdout);
  for (const index of [0, 1, 2]) assert.match(seen[index], /^not ok /u, `${PROBES[index]} catches the machine it reads`);
});

test('gate.io-test-isolation.a-forged-runner-preload-of-the: a forged runner preload of the same name stays foreign [C7]', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-forged-preload-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, 'child-spawn-preload.mjs');
  const declared = `--import=${pathToFileURL(preload).href}`;
  const env = { PULLBOARD_RUNNER_PRELOAD: declared };
  writeFileSync(preload, childJournalPreloadSource(dir));
  assert.equal(foreignNodeOptions(declared, env), false, 'the runner\'s own journal source is known');
  assert.equal(foreignNodeOptions(declared, {}), true, 'undeclared, even the real preload is foreign');
  writeFileSync(preload, `${childJournalPreloadSource(dir)}\nimport 'node:child_process';\n`);
  assert.equal(foreignNodeOptions(declared, env), true, 'one added line makes the declared file foreign');
  writeFileSync(preload, childJournalPreloadSource(join(dir, 'elsewhere')));
  assert.equal(foreignNodeOptions(declared, env), true, 'the source for another directory is foreign');
  rmSync(preload);
  assert.equal(foreignNodeOptions(declared, env), true, 'a missing file is foreign');
  assert.equal(foreignNodeOptions('--import=file:///elsewhere/unclassified.js', env), true, 'an undeclared import is foreign');
});

test('gate.io-test-isolation.gate-ports-preserve-machine-home-and: gate ports preserve machine-home and runtime-preload policy [C7]', () => {
  const override = process.env.PULLBOARD_MACHINE_HOME, accountHome = process.env.PULLBOARD_ACCOUNT_HOME;
  try {
    for (const [machine, account] of [['/tmp/private-machine', '/tmp/private-account'], ['', '/tmp/private-account']]) {
      process.env.PULLBOARD_MACHINE_HOME = machine;
      process.env.PULLBOARD_ACCOUNT_HOME = account;
      assert.equal(gateMachineHome({ override: machine, accountHome: account, osHome: '/unused' }), machineHome());
    }
    for (const directory of ['/tmp/runtime', '/tmp/a quoted path']) {
      assert.equal(gateRuntimeCaptureSource(directory), runtimeCaptureSource(directory));
    }
  } finally {
    if (override === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = override;
    if (accountHome === undefined) delete process.env.PULLBOARD_ACCOUNT_HOME; else process.env.PULLBOARD_ACCOUNT_HOME = accountHome;
  }
});
