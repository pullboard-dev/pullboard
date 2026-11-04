/** Landing retains the first real assertion identity when abort interrupts a reporter [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/index.js';
import { gateSlotEnvironment, takeResource } from '../packages/resources/index.js';
import { runFixtureChild } from './fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');

test('an aborted landing publishes the first failing file and test as a structured outcome [C7,V4]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gate-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const machineHome = join(root, 'machine');
  mkdirSync(machineHome);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  copyPackageFiles(ROOT, root);
  writeFileSync(join(root, 'test', 'spec-failure.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  const env = { ...process.env, ...gateSlotEnvironment(lease), PULLBOARD_MACHINE_HOME: machineHome, PULLBOARD_LANDING_RUN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, [join(root, 'bin', 'run-tests.js'), '--test-reporter=spec', 'test/spec-failure.test.js'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 1, `${result.context}\n${output}`);
  const frame = output.split('\n').find(line => line.startsWith('# pullboard test outcomes '));
  assert.ok(frame, 'the failure remains accounted after landing abort');
  assert.deepEqual(JSON.parse(frame.slice('# pullboard test outcomes '.length)).tests,
    [{ file: 'test/spec-failure.test.js', name: 'spec default failure [C7]', passed: false, skipped: false }]);
});
