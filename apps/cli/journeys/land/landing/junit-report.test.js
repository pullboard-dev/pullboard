/** The landing gate step hands the report gate.junitReport names to landingFailures [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { landingStep } from '../../../tests/fixtures/landing/step.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const FAILING = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="2"><testsuite name="suite" tests="2">
<testcase classname="suite" name="passes" file="a.py"/>
<testcase classname="suite" name="breaks [C7]" file="a.py"><failure message="1 != 2">trace</failure></testcase>
</testsuite></testsuites>`;

/** Run one landing gate group under private machine settings, restoring the machine home afterwards. */
async function withSettings(settings, report, run) {
  const { root: dir } = privateFixtureFiles('pullboard-junit-report-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
  const step = landingStep(helpers, { report });
  try { return await run(step); } finally {
    step.close();
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
  }
}

const ON = { landing: { junitFailures: true }, gate: { junitReport: 'junit.xml' } };

test('cli.journeys-land-landing-junit-report.with-landing-junitfailures-on-and-gate: clause 1: with landing.junitFailures on and gate.junitReport set, a failing report case is named in the receipt failures [C7]', async () => {
  const result = await withSettings(ON, FAILING, step => step.run('junit'));
  assert.deepEqual(result.failures.map(row => [row.name, row.file]), [['breaks [C7]', 'a.py']]);
});

test('cli.journeys-land-landing-junit-report.a-missing-or-damaged-report-falls: clause 2: a missing or damaged report falls back to the output parse and records its code without failing the step [C7]', async () => {
  const damaged = await withSettings(ON, '<testsuites><testsuite><testcase name="a">', step => step.run('damaged'));
  assert.equal(damaged.junitCode, 'JUNIT_DAMAGED');
  assert.equal(damaged.isGreen, true);
  assert.deepEqual(damaged.failures, []);
  const missing = await withSettings({ ...ON, gate: { junitReport: 'absent.xml' } }, FAILING, step => step.run('missing'));
  assert.equal(missing.junitCode, 'JUNIT_UNREADABLE');
  assert.equal(missing.isGreen, true);
});

test('cli.journeys-land-landing-junit-report.with-the-setting-off-the-step: clause 3: with the setting off the step never reads the report [C7]', async () => {
  const off = await withSettings({ gate: { junitReport: 'junit.xml' } }, FAILING, step => step.run('off'));
  assert.deepEqual(off.failures, []);
  assert.equal(off.junitCode, undefined);
});
