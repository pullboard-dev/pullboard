/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** A runner registered with no browser slots runs browser-free test files and never browser-bound ones [C7]. */
import { executionServicesSource } from '../../gate/execution.js';
import { copyPackageFiles } from '../../../../../../packages/runners/index.js';
import { awaitNestedRun } from '../../../../../../packages/gate/index.js';
import assert from 'node:assert/strict';
import { fixtureMachineSettings } from '../../testkit.js';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  listResources,
  takeResource,
} from '../../../../../../packages/resources/index.js';
import {
  runFixtureChild,
  runFixtureChildAsync,
} from '../../child.js';
import {
  HOST,
  installSshStandIn,
  shellQuote,
} from '../ssh.js';
import {
  CHROME,
  DECLARED,
  FREE,
  MARKER,
} from './free/sources.js';

const SOURCE = resolve(import.meta.dirname, '../../../../../..');

/** Count the stand-in's dispatched and returned markers. */
function phases(file) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  return { dispatched: lines.filter(line => line === 'dispatched').length, returned: lines.filter(line => line === 'returned').length };
}

/** Poll a condition with a named hang ceiling. */
async function until(condition, what) {
  const deadline = Date.now() + 60_000; // budget: one runner round trip with checkout and npm setup.
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`fixture wait timed out: ${what}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 50)); // budget: polling interval for fixture state.
  }
}

/** Build a committed repo, a stand-in runner registered with --browser 0, and a held local slot; run body, then restore. */
async function withNoBrowserRunner(t, { cli, git }, body, browserSlots = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-browser-free-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [home, repo, worker, bin, remoteHome] = ['home', 'repo', 'second-machine', 'bin', 'worker-home'].map(name => join(dir, name));
  const machineHome = join(home, '.pullboard');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const requests = join(dir, 'ssh-requests.jsonl');
  for (const folder of [repo, worker, bin, machineHome, remoteMachineHome, join(repo, 'test')]) mkdirSync(folder, { recursive: true });
  // The runner machine has no settings file at all, as on a fresh host.
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner Fixture', GIT_AUTHOR_EMAIL: 'runner-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Runner Fixture', GIT_COMMITTER_EMAIL: 'runner-fixture@example.invalid' };
  // This file runs under the suite's own lease and launch guard; the fixture's runs take their own.
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_TEST_CONTEXT') delete env[key];
  const initialized = runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.context);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'pullboard', version: '0.0.0-fixture', private: true, type: 'module' }) + '\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  copyPackageFiles(SOURCE, repo);
  writeFileSync(join(repo, 'test/free.test.js'), FREE);
  writeFileSync(join(repo, 'test/chrome.test.js'), CHROME);
  writeFileSync(join(repo, 'test/declared.test.js'), DECLARED);
  writeFileSync(join(repo, 'test/marker.test.js'), MARKER);
  git(repo, env, 'add', '.');
  git(repo, env, 'commit', '-q', '-m', 'test: commit a browser-free runner fixture');
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', String(browserSlots), '--json');
  assert.equal(added.status, 0, added.context);

  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = home;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  const slot = { lease: null };
  const fixture = {
    repo, env, slot, marks: `${requests}.phases`,
    phases: () => phases(`${requests}.phases`),
    runTests: file => runFixtureChildAsync(process.execPath, ['packages/gate/src/io/run/tests.js', file], { cwd: repo, env }),
    show: result => `${result.context}\nstdout:\n${result.stdout}`,
    // Fill the controller's only gate slot so a remote-capable run goes to the runner.
    hold: async () => { slot.lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
      agent: 'browser-free-local-holder', item: 'local-holder', kind: 'force-registered-runner' }); },
    free: () => { slot.lease?.release(); slot.lease = null; },
  };
  try { await body(fixture); }
  finally {
    fixture.free();
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  }
}

/** Run one command through the repo's own gate API, as an item check does, with no browser slot asked. */
function gateRun({ repo, env }, command, runnerOnly = false) {
  const gateUrl = pathToFileURL(join(repo, 'packages', 'gate', 'index.js')).href;
  const script = `const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
${executionServicesSource(gateUrl)}
const result = await withGateSlot(${JSON.stringify(repo)}, lease => runProfiledShell(${JSON.stringify(repo)}, ${JSON.stringify(command)}, { gateLease: lease }),
  { executionServices, browser: false, runnerOnly: ${runnerOnly}, item: '1043', kind: 'check', itemCheck: true, agent: 'browser-free-fixture' });
process.stdout.write(result.output);
process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: result.isGreen, runner: result.profile.executionRunner ?? null, runnerAttempt: result.runnerAttempt ?? null }) + '\\n');
process.exitCode = result.isGreen ? 0 : 1;
`;
  return runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env });
}

/** An authenticated worker refusal is retried on a real remote browser lease [C7]. */
export async function browserRefusalRetriesRunner(t, helpers) {
  await withNoBrowserRunner(t, helpers, async fixture => {
    const command = `PULLBOARD_TEST_REUSE=0 node packages/gate/src/io/run/tests.js ${shellQuote('test/declared.test.js')}`;
    const result = await awaitNestedRun(gateRun(fixture, command, true));
    assert.equal(result.status, 0, fixture.show(result));
    assert.match(result.stderr, /retrying on an eligible runner with a browser slot/u);
    const record = JSON.parse(result.stdout.split('\n').findLast(line => line.startsWith('PULLBOARD_RUN_RESULT ')).slice('PULLBOARD_RUN_RESULT '.length));
    assert.equal(record.runner, HOST);
    assert.equal(record.runnerAttempt.host, HOST);
    // The stand-in marks returned when its worker closes, which can trail the result the controller read.
    await until(() => fixture.phases().returned === 2, 'the retried runner run closes');
    assert.deepEqual(fixture.phases(), { dispatched: 2, returned: 2 });
  }, 1);
}

/** A browser-free file runs green on the no-browser runner; a lease refusal reruns locally; a browser-bound file stays local. */
export async function browserFreeRunnerCheck(t, helpers) {
  await withNoBrowserRunner(t, helpers, async (fixture) => {
    const { runTests, show, hold, free } = fixture;
    await hold();
    const ran = await awaitNestedRun(runTests('test/free.test.js'));
    assert.doesNotMatch(ran.stdout + ran.stderr, /BROWSER_SLOT_REQUIRED/u, show(ran));
    assert.equal(ran.status, 0, show(ran));
    assert.match(ran.stdout, /^ok 1 - browser-free file ran/mu, show(ran));
    assert.deepEqual(fixture.phases(), { dispatched: 1, returned: 1 }, 'the browser-free file ran on the no-browser runner');

    // A run handed a lease without a browser slot whose file declares a browser has its lease guard refuse
    // on the runner; the guard's receipt, not any text, reruns it locally. Opt out of result reuse: the
    // refusal needs a real execution.
    const command = `PULLBOARD_TEST_REUSE=0 node packages/gate/src/io/run/tests.js ${shellQuote('test/declared.test.js')}`;
    const pending = gateRun(fixture, command);
    await until(() => fixture.phases().returned === 2, 'the runner answers the refused run');
    free();
    const rerun = await awaitNestedRun(pending);
    assert.equal(rerun.status, 0, show(rerun));
    assert.match(rerun.stderr, /RUNNER_BROWSER_SLOT_REQUIRED[^\n]*its attempt \(exit 1\):\n[^]*run-tests: \[BROWSER_SLOT_REQUIRED\][^]*rerunning it locally with a browser slot/u, show(rerun));
    const record = JSON.parse(rerun.stdout.split('\n').findLast(line => line.startsWith('PULLBOARD_RUN_RESULT ')).slice('PULLBOARD_RUN_RESULT '.length));
    assert.equal(record.runner, null, 'the green result is the local rerun');
    assert.equal(record.runnerAttempt.host, HOST, 'the runner attempt is kept beside it');
    assert.match(record.runnerAttempt.output, /\[BROWSER_SLOT_REQUIRED\] the inherited gate lease does not hold the browser slot/u);
    assert.match(rerun.stdout, /^ok 1 - declared file ran/mu, show(rerun));
    assert.deepEqual(fixture.phases(), { dispatched: 2, returned: 2 }, 'the local rerun never went back to the runner');

    // A browser-bound file waits for a local slot rather than going to a runner with no browser slots.
    await hold();
    const bound = runTests('test/chrome.test.js');
    const waiting = () => listResources({ scope: 'machine', root: fixture.repo }).find(resource => resource.name === 'gate')?.line.length === 1;
    await until(waiting, 'the browser-bound run queues');
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000)); // budget: several admission polls in which a runner could take it.
    assert.equal(waiting(), true, 'the browser-bound run still waits for a local slot');
    free();
    const local = await awaitNestedRun(bound);
    assert.equal(local.status, 0, show(local));
    assert.match(local.stdout, /^ok 1 - browser-bound file ran/mu, show(local));
    assert.deepEqual(fixture.phases(), { dispatched: 2, returned: 2 }, 'the browser-bound file never reached the runner');
  });
}

/**
 * On a gate.runnersOnly machine the same lease refusal ends the run as the runner's refusal: it never reruns locally,
 * so the gate requeues on a runner (#3898).
 */
export async function runnersOnlyRefusalStaysOnRunner(t, helpers) {
  await withNoBrowserRunner(t, helpers, async (fixture) => {
    const { show, hold, free } = fixture;
    // Keep the registered runner: only gate.runnersOnly is added to this machine's settings.
    const settings = JSON.parse(readFileSync(join(fixture.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8'));
    fixtureMachineSettings(fixture.env.PULLBOARD_MACHINE_HOME, { ...settings, gate: { ...settings.gate, runnersOnly: true } });
    await hold();
    const command = `PULLBOARD_TEST_REUSE=0 node packages/gate/src/io/run/tests.js ${shellQuote('test/declared.test.js')}`;
    const pending = gateRun(fixture, command);
    await until(() => fixture.phases().returned === 1, 'the runner answers the refused run');
    free();
    const refused = await awaitNestedRun(pending);
    assert.notEqual(refused.status, 0, show(refused));
    assert.match(refused.stderr, /RUNNER_BROWSER_SLOT_REQUIRED/u, show(refused));
    assert.doesNotMatch(refused.stderr, /rerunning it locally/u, 'nothing reruns on the coordinator');
    assert.doesNotMatch(refused.stdout, /^ok 1 - declared file ran/mu, 'the declared file never ran locally');
  });
}

/** Control: a test that prints or throws the refusal text on a runner stays red and is never rerun. */
export async function browserRefusalTextStaysRed(t, helpers) {
  await withNoBrowserRunner(t, helpers, async (fixture) => {
    const { runTests, show, hold } = fixture;
    await hold();
    const red = await awaitNestedRun(runTests('test/marker.test.js'));
    assert.equal(red.status, 1, show(red));
    assert.match(red.stdout, /^not ok 1 - marker file ran/mu, show(red));
    assert.match(red.stdout, /\[BROWSER_SLOT_REQUIRED\] thrown by a test/u, show(red));
    assert.doesNotMatch(red.stderr, /RUNNER_BROWSER_SLOT_REQUIRED|rerunning it locally/u, show(red));
    await until(() => fixture.phases().returned === 1, 'the runner run closes');
    assert.deepEqual(fixture.phases(), { dispatched: 1, returned: 1 }, 'the red came from the runner, once');
  });
}
