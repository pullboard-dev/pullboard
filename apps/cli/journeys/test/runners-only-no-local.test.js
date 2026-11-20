/** With gate.runnersOnly on and no runner free, gate, comparison, smoke and cells-plan jobs wait for a runner and none runs locally [C7,#3011,#8929]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { compareMainFailures } from '../../../../packages/landing/index.js';
import { landingPlanCheck } from '../../../../packages/landing/index.js';
import { realGitAdapter } from '../../../../packages/git/index.js';
import { withGitAdapter } from '../../../../packages/git/index.js';
import { smokeCandidate } from '../../../../packages/landing/index.js';
import { gateRunnerAdmission } from '../../../../packages/config/index.js';
import { withEnvironment } from '../../../../packages/resources/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
const roots = [];
after(helpers.cleanup);
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

/**
 * A committed repository whose test runner writes a marker when it runs, and a machine with gate.runnersOnly on and no runner registered.
 * Anything that executes on this machine instead of waiting leaves the marker, so each case reads one place for "ran locally".
 */
function lonely(extra = {}) {
  const directory = privateFixtureFiles('pullboard-runners-only-none-').root;
  roots.push(directory);
  const graph = fixtureCommittedGraph('pullboard-runners-only-none-repo-');
  roots.push(graph.root);
  const machine = join(directory, 'machine');
  const marker = join(directory, 'ran-locally');
  mkdirSync(machine, { recursive: true });
  graph.put('package.json', JSON.stringify({ private: true, type: 'module' }) + '\n');
  fixtureProjectPolicy(graph.root, { config: { gate: 'node test/runner.js', affectedTests: 'node test/runner.js' } });
  graph.put('test/inherited.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the inherited main failure stays named [V4]', () => assert.equal(1, 2));\n");
  for (const [file, text] of Object.entries(extra)) graph.put(file, text);
  graph.put('test/runner.js', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  graph.put('apps/cli/pullboard.js', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const main = graph.commit();
  fixtureMachineSettings(machine, { gateSlots: 1, browserSlots: 1, gate: { browserFreeChecks: true, timingRunner: false, runnersOnly: true, runnerWaitMs: 80 }, runners: [] });
  const env = { PATH: process.env.PATH, HOME: directory, PULLBOARD_HOME: directory, PULLBOARD_MACHINE_HOME: machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  return { root: graph.root, main, marker, env };
}

test('cli.journeys-test-runners-only-no-local.with-no-runner-free-the-main: clause 1: with no runner free, the main comparison waits and starts no local run [C7,#3011]', { timeout: 60000 }, async () => {
  const box = lonely();
  const started = [];
  let outcome;
  await withEnvironment(box.env, async () => {
    try {
      outcome = await compareMainFailures(box.root, { tests: [{ file: 'test/inherited.test.js', passed: false }] }, undefined, '', {
        env: box.env, commit: box.main, detailed: true, fresh: true, onStart: start => started.push(start) });
    } catch (error) { outcome = { thrown: error }; }
  });
  assert.deepEqual(started, [], 'no run started anywhere');
  assert.equal(existsSync(box.marker), false, 'no test process ran on this machine');
  assert.ok(outcome?.thrown?.code === 'RUNNER_WAIT_DEADLINE' || /runner/iu.test(String(outcome?.unavailable ?? '')), `the comparison named the runner wait: ${JSON.stringify(outcome?.unavailable ?? outcome?.thrown?.message)}`);
});

test('cli.journeys-test-runners-only-no-local.with-no-runner-free-the-landing: clause 1: with no runner free, the landing CLI smoke waits for a runner and runs no local process [C7,#3011]', { timeout: 60000 }, async () => {
  const box = lonely();
  let refusal = null;
  await withEnvironment(box.env, async () => {
    try { await smokeCandidate(box.root, { admission: gateRunnerAdmission() }); } catch (error) { refusal = error; }
  });
  assert.equal(refusal?.code, 'RUNNER_WAIT_DEADLINE', refusal?.message);
  assert.equal(existsSync(box.marker), false, 'the smoke ran on no local process');
});

test('cli.journeys-test-runners-only-no-local.with-no-runner-free-the-gate: clause 1: with no runner free, the gate of a submit waits for a runner and runs no local body [C7,#3011]', { timeout: 120000 }, async () => {
  const box = helpers.project('true');
  const marker = join(box.dir, 'gate-ran-locally');
  const command = `printf ran > '${marker.replaceAll("'", "'\\''")}'`;
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Gate waits for a runner', '--specs', 'G1',
    '--criterion', 'The frozen check never runs on this machine.', '--check', command, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const committed = helpers.commitFile(box, box.web, 'web/no-local.js', 'export const waits = true;\n', 'feat(web): the gate waits for a runner [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  rmSync(marker, { force: true });
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...previous, gateSlots: 1, browserSlots: 1, gate: { ...previous.gate, runnersOnly: true, runnerWaitMs: 80 } }));
  const refused = await box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json');
  assert.notEqual(refused.code, 0, refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'RUNNER_WAIT_DEADLINE', refused.err || refused.out);
  assert.equal(existsSync(marker), false, 'the frozen check never ran locally');
});

test('cli.journeys-test-runners-only-no-local.with-no-runner-free-the-cells: clause 1: with no runner free, the cells-plan check reads Git objects only, runs no local process and still refuses an unnumbered engine [C7,#3011]', { timeout: 60000 }, async () => {
  const box = lonely({ 'packages/state/src/logic/engines/new-rule-engine.js': "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n" });
  const spawned = [];
  const spy = { ...realGitAdapter, spawnSync(args, options) { spawned.push(args[0]); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { spawned.push(args[0]); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { spawned.push(args[0]); return realGitAdapter.spawn(args, options); } };
  let refusal = null;
  await withEnvironment(box.env, () => withGitAdapter(spy, async () => { try { await landingPlanCheck(box.root, box.main); } catch (error) { refusal = error; } }));
  assert.equal(refusal?.code, 'LAND_ENGINE_UNNUMBERED', `the check answered at once instead of waiting: ${refusal?.message}`);
  assert.ok(spawned.length > 0 && spawned.every(command => ['ls-tree', 'cat-file'].includes(command)), `only Git object reads: ${spawned.join(',')}`);
  assert.equal(existsSync(box.marker), false, 'the plan check ran no local test or CLI process');
});
