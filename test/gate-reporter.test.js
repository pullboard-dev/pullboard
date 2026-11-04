/** Landing retains the first real assertion identity when abort interrupts a reporter [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/index.js';
import { gateSlotEnvironment, inheritedGateSlot, takeResource } from '../packages/resources/index.js';
import { gateRunnerAdmission } from '../packages/config/index.js';
import { runFixtureChild } from './fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');

test('an aborted landing publishes the first failing file and test as a structured outcome [C7,V4]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gate-reporter-'));
  const machineHome = join(root, 'machine');
  mkdirSync(machineHome);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  copyPackageFiles(ROOT, root);
  const runnerPath = join(root, 'bin', 'run-tests.js');
  let runner = readFileSync(runnerPath, 'utf8');
  const reporterAnchor = "      output.once('end', resolveEnd);\n      output.once('close', resolveEnd);";
  assert.ok(runner.includes(reporterAnchor));
  runner = runner.replace(reporterAnchor,
    "      output.once('end', () => { process.stderr.write('TRACE reporter: output end\\n'); resolveEnd(); });\n      output.once('close', () => { process.stderr.write('TRACE reporter: output close\\n'); resolveEnd(); });\n      output.once('error', error => process.stderr.write('TRACE reporter: output error ' + error.message + '\\n'));" );
  const endAnchor = "    if (reportersEnded) return;\n    reportersEnded = true;\n    for (const reporter of reporters) reporter.end();";
  assert.ok(runner.includes(endAnchor));
  runner = runner.replace(endAnchor,
    "    process.stderr.write('TRACE reporter: end requested, ended=' + reportersEnded + '\\n');\n    if (reportersEnded) return;\n    reportersEnded = true;\n    for (const reporter of reporters) { process.stderr.write('TRACE reporter: input before end ' + reporter.writableEnded + '\\n'); reporter.end(); process.stderr.write('TRACE reporter: input after end ' + reporter.writableEnded + '\\n'); }");
  const awaitAnchor = "    await abortPromise;\n    // Abort can close the dispatcher stream without ending it.";
  assert.ok(runner.includes(awaitAnchor));
  runner = runner.replace(awaitAnchor,
    "    await abortPromise;\n    process.stderr.write('TRACE reporter: after abort, reporterEnds=' + reporterEnds.length + '\\n');\n    // Abort can close the dispatcher stream without ending it.");
  writeFileSync(runnerPath, runner);
  const activityMarker = join(root, 'fixture-activity');
  writeFileSync(join(root, 'test', 'spec-failure.test.js'), `import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
writeFileSync(${JSON.stringify(activityMarker)}, 'loaded');
test('spec default failure [C7]', () => assert.fail('intentional reporter fixture failure'));
`);
  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let lease;
  try { lease = await takeResource({ name: 'gate', capacity: 1, root, agent: 'gate-reporter-fixture' }); }
  finally {
    if (priorMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = priorMachineHome;
  }
  t.after(() => {
    const currentMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = machineHome;
    try { lease.release(); }
    finally {
      if (currentMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = currentMachineHome;
    }
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ...gateSlotEnvironment(lease), PULLBOARD_MACHINE_HOME: machineHome, PULLBOARD_LANDING_RUN: '1' };
  const admissionKeys = ['PULLBOARD_MACHINE_HOME', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD'];
  const previousAdmission = new Map(admissionKeys.map(key => [key, process.env[key]]));
  let inherited, runnerOnly;
  try {
    for (const key of admissionKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    inherited = inheritedGateSlot({ root, namedFiles: false });
    runnerOnly = gateRunnerAdmission().runnerOnly === true;
  } finally {
    for (const [key, value] of previousAdmission) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.ok(inherited, 'fixture child has the exact live gate lease for its private machine home');
  assert.equal(inherited.runnerExecution, false, 'fixture lease is local and does not claim a runner execution');
  assert.equal(runnerOnly, false, 'fixture machine does not require a registered runner');
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'PULLBOARD_RUNNER_PRELOAD', 'PULLBOARD_RUNNER_JOB', 'PULLBOARD_RUNNER_INSTANCE', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  const result = runFixtureChild(process.execPath, [join(root, 'bin', 'run-tests.js'), '--test-reporter=spec', 'test/spec-failure.test.js'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const output = `fixture loaded=${existsSync(activityMarker)}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 1, `${result.context}\n${output}`);
  const frame = output.split('\n').find(line => line.startsWith('# pullboard test outcomes '));
  assert.ok(frame, 'the failure remains accounted after landing abort');
  assert.deepEqual(JSON.parse(frame.slice('# pullboard test outcomes '.length)).tests,
    [{ file: 'test/spec-failure.test.js', name: 'spec default failure [C7]', passed: false, skipped: false }]);
});
