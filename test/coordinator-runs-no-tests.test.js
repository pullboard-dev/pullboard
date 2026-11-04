/** @pullboard-test-input source-tree */
/** With gate.runnersOnly on, main comparisons, the landing CLI smoke and the cells-plan check run on a runner and queue, never local [C7,#3011]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';
import { runFixtureChildAsync } from './fixture-child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = 'coordinator-runs-no-tests-fixture'; return box; } });
const landing = pathToFileURL(resolve(import.meta.dirname, '../packages/landing/index.js')).href;

/** A land project whose committed tree carries a failing main test, a cells-plan check and a smoke stub; each names the HOME it ran under. */
function runnerProject({ healthDown = false } = {}) {
  const box = landProject();
  const marker = join(box.dir, 'local-ran');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/landing/src/shell'), { recursive: true });
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  writeFileSync(join(box.repo, 'web/land-1.test.js'), '// RED NAME:main-red-case\n');
  writeFileSync(join(box.repo, 'bin/cells-plan.json'), '{"cells":[]}\n');
  // Each script leaves a marker only when it runs under this machine's HOME, so a local fallback is visible.
  const mark = `import { writeFileSync } from 'node:fs'; if (process.env.HOME === ${JSON.stringify(box.env.HOME)}) writeFileSync(${JSON.stringify(marker)}, 'local');`;
  writeFileSync(join(box.repo, 'bin/cells-plan.js'), `${mark}\nconsole.log('not in bin/cells-plan.json: ran-at:' + process.env.HOME);\nprocess.exit(1);\n`);
  writeFileSync(join(box.repo, 'bin/pullboard.js'), '');
  writeFileSync(join(box.repo, 'packages/landing/src/shell/landing-cli-smoke.js'), `${mark}\nexport function runLandingCliSmoke() { console.error('smoke-ran-at:' + process.env.HOME); process.exit(1); }\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: runner-only landing checks');
  const worker = join(box.dir, 'runner-worker'), sshBin = join(box.dir, 'runner-bin'), remoteHome = join(box.dir, 'runner-home');
  const remoteMachine = join(remoteHome, '.pullboard'), requests = join(box.dir, 'runner-requests.jsonl'), starts = join(box.dir, 'runner-starts.jsonl');
  for (const path of [worker, sshBin, remoteHome, remoteMachine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: sshBin, worker, home: remoteHome, machineHome: remoteMachine, requests, starts, healthDown, workerHealthDown: healthDown });
  box.env.PATH = `${sshBin}:${box.env.PATH}`;
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    runners: [{ host: HOST, slots: 1, browser: 1 }], gate: { runnersOnly: true, memoryFloorMB: 0, ...(healthDown ? { runnerWaitMs: 3000 } : {}) } }));
  return { box, marker, remoteHome, starts, main: box.git(box.repo, 'rev-parse', 'HEAD') };
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
  const { box, marker, remoteHome, starts, main } = runnerProject();
  const module = pathToFileURL(resolve(import.meta.dirname, '../packages/landing/src/shell/main-red.js')).href;
  const out = await inChild(box, `
    const { compareMainFailures } = await import(${JSON.stringify(module)});
    // No runnerAdmission is named: the machine's gate.runnersOnly setting alone sends it to a runner.
    const compare = await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
      { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true });
    const plan = await settle(() => landing.landingPlanCheck(${JSON.stringify(box.repo)}, ${JSON.stringify(main)}));
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
  const { box, marker, main } = runnerProject({ healthDown: true });
  const module = pathToFileURL(resolve(import.meta.dirname, '../packages/landing/src/shell/main-red.js')).href;
  const out = await inChild(box, `
    const { compareMainFailures } = await import(${JSON.stringify(module)});
    const compare = await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
      { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true });
    const plan = await settle(() => landing.landingPlanCheck(${JSON.stringify(box.repo)}, ${JSON.stringify(main)}));
    const smoke = await settle(() => landing.smokeCommit(${JSON.stringify(box.repo)}, ${JSON.stringify(main)}));
    process.stdout.write(JSON.stringify({ compare, plan, smoke }));
  `);
  assert.deepEqual(out.compare.files, []);
  assert.equal(out.compare.runnerOnly, true, JSON.stringify(out.compare));
  assert.equal(out.plan.code, 'RUNNER_WAIT_DEADLINE', out.plan.message);
  assert.equal(out.smoke.code, 'RUNNER_WAIT_DEADLINE', out.smoke.message);
  assert.equal(existsSync(marker), false, 'no check fell back to a local process');
});
