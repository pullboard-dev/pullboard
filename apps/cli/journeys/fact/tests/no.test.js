/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/landing/index.js packages/landing/src/io/main/red.js packages/landing/src/io/step/trunk.js packages/landing/src/io/smoke.js packages/gate/src/io/execution.js packages/runners/index.js */
/** With gate.runnersOnly on, main comparisons, the landing CLI smoke and the cells-plan check run on a runner and queue, never local [C7,#3011]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  HOST,
  installSshStandIn,
} from '../../../tests/fixtures/runner/ssh.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';
import { fixtureCellsPlan } from '../../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = FIXTURE_MODEL; return box; } });
const landing = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/landing/index.js')).href;

/** A land project whose committed tree carries a failing main test, a cells-plan check and a smoke stub; each names the HOME it ran under. */
function runnerProject({ healthDown = false } = {}) {
  const box = landProject();
  const marker = join(box.dir, 'local-ran');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/landing/src/io'), { recursive: true });
  mkdirSync(join(box.repo, 'apps/cli'), { recursive: true });
  writeFileSync(join(box.repo, 'web/land-1.test.js'), '// RED NAME:main-red-case\n');
  // Each script leaves a marker only when it runs under this machine's HOME, so a local fallback is visible.
  const mark = `import { writeFileSync } from 'node:fs'; if (process.env.HOME === ${JSON.stringify(box.env.HOME)}) writeFileSync(${JSON.stringify(marker)}, 'local');`;
  writeFileSync(join(box.repo, 'apps/cli/pullboard.js'), '');
  writeFileSync(join(box.repo, 'packages/landing/src/io/smoke.js'), `${mark}\nexport function runLandingCliSmoke() { console.error('smoke-ran-at:' + process.env.HOME); process.exit(1); }\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: runner-only landing checks');
  // A separate foreign project owns its plan schema and its committed checker; the native project has no cells plan.
  const foreign = join(box.dir, 'foreign-plan-project');
  mkdirSync(join(foreign, 'packages/codemap/src/io/cells/scripts'), { recursive: true });
  mkdirSync(join(foreign, 'packages/codemap/data/plan'), { recursive: true });
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ type: 'module' }));
  fixtureCellsPlan(foreign, JSON.stringify({ placed: [] }));
  writeFileSync(join(foreign, 'packages/codemap/src/io/cells/scripts/plan.js'), `${mark}\nconsole.log('not in packages/codemap/data/plan/cells.json: ran-at:' + process.env.HOME);\nprocess.exit(1);\n`);
  box.git(foreign, 'init', '-q', '-b', 'main');
  box.git(foreign, 'add', '-A');
  box.git(foreign, 'commit', '-q', '-m', 'test: foreign plan checker');
  const foreignMain = box.git(foreign, 'rev-parse', 'HEAD');
  const worker = join(box.dir, 'runner-worker'), sshBin = join(box.dir, 'runner-bin'), remoteHome = join(box.dir, 'runner-home');
  const remoteMachine = join(remoteHome, '.pullboard'), requests = join(box.dir, 'runner-requests.jsonl'), starts = join(box.dir, 'runner-starts.jsonl');
  for (const path of [worker, sshBin, remoteHome, remoteMachine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: sshBin, worker, home: remoteHome, machineHome: remoteMachine, requests, starts, healthDown, workerHealthDown: healthDown });
  box.env.PATH = `${sshBin}:${box.env.PATH}`;
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gateSlots: 1, browserSlots: 1,
    runners: healthDown ? [] : [{ host: HOST, slots: 1, browser: 1 }], gate: { runnersOnly: true, memoryFloorMB: 0, ...(healthDown ? { runnerWaitMs: 1000 } : {}) } });
  return { box, marker, remoteHome, starts, foreign, foreignMain, main: box.git(box.repo, 'rev-parse', 'HEAD') };
}

/** Run one script against the landing package in a child under the box's machine settings and return its JSON line. */
async function inChild(box, body) {
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    const landing = await import(${JSON.stringify(landing)});
    const settle = async run => { try { return { value: await run() }; } catch (error) { return { code: error.code, message: error.message }; } };
    ${body}
  `], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 150_000 }); // budget: up to three real runner round trips.
  assert.equal(result.status, 0, result.stderr || result.failure);
  return JSON.parse(result.stdout);
}

/** Count real job dispatches the ssh stand-in started. */
function jobs(starts) { return existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0; }

test('with gate.runnersOnly on, a main comparison, the CLI smoke and the cells-plan check each run on a runner [C7,#3011]', { timeout: 240_000 }, async () => {
  const { box, marker, remoteHome, starts, main, foreign, foreignMain } = runnerProject();
  const module = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/landing/src/io/main/red.js')).href;
  const out = await inChild(box, `
    const { compareMainFailures } = await import(${JSON.stringify(module)});
    // No runnerAdmission is named: the machine's gate.runnersOnly setting alone sends it to a runner.
    const compare = await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
      { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true });
    const plan = await settle(() => landing.landingPlanCheck(${JSON.stringify(foreign)}, ${JSON.stringify(foreignMain)}));
    const smoke = await settle(() => landing.smokeCommit(${JSON.stringify(box.repo)}, ${JSON.stringify(main)}));
    process.stdout.write(JSON.stringify({ compare, plan, smoke }));
  `);
  assert.equal(out.compare.unavailable, undefined, out.compare.unavailable);
  assert.deepEqual(out.compare.files.map(row => [row.file, row.result]), [['web/land-1.test.js', 'red']]);
  assert.equal(out.plan.code, 'LAND_PLAN_UNPLACED', out.plan.message);
  assert.ok(out.plan.message.includes(`ran-at:${remoteHome}`), `the plan check ran off the runner: ${out.plan.message}`);
  assert.equal(out.smoke.code, 'LAND_CLI_SMOKE', out.smoke.message);
  assert.match(out.smoke.message, new RegExp(`on runner ${HOST}`, 'u'));
  assert.ok(jobs(starts) >= 3, `expected three runner jobs, saw ${jobs(starts)}`);
  assert.equal(existsSync(marker), false, 'no check ran as a local process');
});

test('with gate.runnersOnly on and no runner free, each check queues to the runner deadline and never runs locally [C7,#3011]', { timeout: 240_000 }, async () => {
  const { box, marker, main, foreign, foreignMain } = runnerProject({ healthDown: true });
  const module = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/landing/src/io/main/red.js')).href;
  const out = await inChild(box, `
    const { compareMainFailures } = await import(${JSON.stringify(module)});
    const compare = await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
      { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true });
    const plan = await settle(() => landing.landingPlanCheck(${JSON.stringify(foreign)}, ${JSON.stringify(foreignMain)}));
    const smoke = await settle(() => landing.smokeCommit(${JSON.stringify(box.repo)}, ${JSON.stringify(main)}));
    process.stdout.write(JSON.stringify({ compare, plan, smoke }));
  `);
  assert.deepEqual(out.compare.files, []);
  assert.equal(out.compare.runnerOnly, true, JSON.stringify(out.compare));
  // No runner is registered while this machine has an idle local slot: every check waits for the runner deadline.
  for (const [name, result] of [['plan', out.plan], ['smoke', out.smoke]]) assert.equal(result.code, 'RUNNER_WAIT_DEADLINE', `${name} did not queue: ${result.message}`);
  assert.equal(existsSync(marker), false, 'no check fell back to a local process');
});

test('clause 1: the landing guards smoke a tree its submit gate proved through the runner-dispatching smoke, never the local one [C7,#3011]', async () => {
  const trunk = await import(pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/landing/src/io/step/trunk.js')).href);
  const smoke = await import(pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/landing/src/io/smoke.js')).href);
  assert.equal(trunk.landingSmoke({}), smoke.smokeCandidate, 'with no stand-in the guards use smokeCandidate, which runs on a runner when gate.runnersOnly is on');
  assert.notEqual(trunk.landingSmoke({}), smoke.runLandingCliSmoke, 'the local smoke is never the default');
  const standIn = () => ({ ran: [] });
  assert.equal(trunk.landingSmoke({ runLandingCliSmoke: standIn }), standIn);
});

test('clause 1: on a runners-only coordinator a sharded landing gate runs on a runner, never as a local test process [C7,#3899]', { timeout: 240_000 }, async () => {
  const { box, marker, remoteHome } = runnerProject();
  // A sharded project once kept the gate's controller here, where the coordinator guard refuses packages/gate/src/io/run/tests.js at once.
  const configFile = join(box.repo, 'pullboard.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  writeFileSync(configFile, JSON.stringify({ ...config, landingShards: 2 }, null, 2) + '\n');
  const mark = `import { writeFileSync } from 'node:fs'; if (process.env.HOME === ${JSON.stringify(box.env.HOME)}) writeFileSync(${JSON.stringify(marker)}, 'local');`;
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  writeFileSync(join(box.repo, 'bin/gate-probe.js'), `${mark}\nconsole.log('gate-ran-at:' + process.env.HOME);\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: sharded landing gate probe');
  const gate = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/execution.js')).href;
  const runners = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/runners/index.js')).href;
  const out = await inChild(box, `
    const { runGate } = await import(${JSON.stringify(gate)});
    const { runnerExecutionServices } = await import(${JSON.stringify(runners)});
    const run = await settle(() => runGate(${JSON.stringify(box.repo)}, { gate: 'node bin/gate-probe.js' }, { landing: true, trustStamp: false, collectAll: true,
      agent: 'coordinator', executionServices: { runners: runnerExecutionServices(), landing: landing.landingExecutionServices() } }));
    process.stdout.write(JSON.stringify({ code: run.code, message: run.message, output: run.value?.output ?? '' }));
  `);
  assert.equal(out.code, undefined, out.message);
  assert.ok(out.output.includes(`gate-ran-at:${remoteHome}`), `the landing gate did not run on the runner: ${out.output}`);
  assert.equal(existsSync(marker), false, 'the landing gate ran as a local process on the coordinator');
});
