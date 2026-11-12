/** @pullboard-test-input packages/gate/src/io/run/tests.js packages/resources/index.js */
/** A gate receipt splits waiting for a machine slot from running the check, and the stats line reports both [C7,V10]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { copyFixtureRunner } from '../../../../packages/gate/tests/fixtures/copy.js';

const savedContext = process.env.NODE_TEST_CONTEXT;
const savedOptions = process.env.NODE_OPTIONS;
test.before(() => { delete process.env.NODE_TEST_CONTEXT; delete process.env.NODE_OPTIONS; });
test.after(() => { if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = savedContext; if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions; });

test('a gate receipt splits waiting from running [C7,V10]', async t => {
  const { createE2eHelpers } = await import('../../tests/fixtures/e2e.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // A check the runner can classify: this repo's own runner and one named file that never launches a browser.
  copyFixtureRunner(resolve(import.meta.dirname, '../../../..'), box.repo);
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/quick.test.js'), "import { test } from 'node:test'; test('quick', () => new Promise(done => setTimeout(done, 200)));\n");
  // The fixture lane must own the paths its check names, or the claim refuses with CROSS_OWNERSHIP.
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.web.owns.push('test/', 'apps/cli/src/io/run/tests.js');
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '.');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add a browser-free named check');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { browserFreeChecks: true, runnersFirst: false, runnersOnly: false } }));
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Timed check', '--criterion', 'the check runs', '--check', 'node apps/cli/src/io/run/tests.js test/quick.test.js', '--route', 'strong').code, 0);
  const claimedOne = (await box.runLocal(box.web, 'claim', '1'));
  assert.equal(claimedOne.code, 0, `${claimedOne.out}${claimedOne.err}`);
  // A stand-in holds the only slot for HOLD_MS, then lets the check in.
  const HOLD_MS = 6000; // budget: long enough that the wait cannot be confused with the check's own ~2 s of runner startup on a loaded runner.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { takeResource } from ${JSON.stringify(resolve(import.meta.dirname, '../../../../packages/resources/index.js'))};
const lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: ${JSON.stringify(box.repo)}, agent: 'receipt-stand-in' });
console.log('ready'); setTimeout(() => { lease.release(); process.exit(0); }, ${HOLD_MS});`], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise(ready => holder.stdout.once('data', ready));
  const checked = (await box.runLocal(box.web, 'check', '1', '--yes', '--json'));
  assert.equal(checked.code, 0, checked.out + checked.err);
  const receipt = JSON.parse(checked.out).result?.receipt ?? JSON.parse(checked.out).receipt;
  assert.ok(receipt, checked.out);
  assert.ok(receipt.waitMs >= HOLD_MS - 1000, `the wait covers the stand-in's hold: ${JSON.stringify(receipt)}`);
  assert.ok(receipt.runMs >= 150 && receipt.runMs < HOLD_MS - 1000, `the run time covers only the test: ${JSON.stringify(receipt)}`);
  for (const field of ['admissionMs', 'setupMs', 'evidenceMs']) assert.ok(Number.isFinite(receipt[field]) && receipt[field] >= 0, field);
  assert.deepEqual(receipt.slot, { kind: 'ordinary', reason: 'it launches no browser' }, 'the slot kind and why');
  const stats = (await box.runLocal(box.repo, 'stats'));
  assert.match(stats.out, /gate waits, last day:\n {2}check: 1 run; wait median \d+\.\d{2}s, slowest \d+\.\d{2}s; run median \d+\.\d{2}s/u, stats.out);
});
