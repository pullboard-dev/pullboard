/** Red baselines and derived main-red repairs retain named first diagnostics [C7,V4]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixture,
  cli,
  rows,
} from '../../tests/fixtures/affected.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { baselineFailureDetails } from '../../../../packages/gate/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';

test('a red baseline with two real failing cases prints both first error lines in show [C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const bin = join(box.dir, 'ssh-bin');
  const worker = join(box.dir, 'worker');
  const home = join(box.dir, 'worker-home');
  const machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests: join(box.dir, 'ssh-requests.jsonl') });
  box.env.PATH = bin + ':' + box.env.PATH;
  const registered = await box.inProcess(box.repo, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(registered.code, 0, registered.err);
  const settings = await box.inProcess(box.repo, 'settings', 'gate.loadAwareDispatch', 'off', '--json');
  assert.equal(settings.code, 0, settings.err);
  // The private CLI launches its own test process, not a child of this node:test protocol.
  delete box.env.NODE_TEST_CONTEXT;
  writeFileSync(join(box.repo, 'two-fail.test.js'), "import { test } from 'node:test';\ntest('first broken case', () => { throw new Error('first diagnostic'); });\ntest('second broken case', () => { throw new Error('second diagnostic'); });\n");
  box.git(box.repo, 'add', 'two-fail.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: two failing baseline cases');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Repair both cases', '--specs', 'G1', '--criterion', 'Both cases pass.', '--check', 'node --test two-fail.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const shown = await box.inProcess(box.repo, 'show', String(id));
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /first broken case: first diagnostic/u);
  assert.match(shown.out, /second broken case: second diagnostic/u);
});

test('a derived main-red repair keeps the actual first error line and show prints it [C7,V4]', t => {
  const box = fixture(t, { autoFileMainReds: true });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const repairs = rows(box, "SELECT * FROM item WHERE item_title LIKE 'Main red:%'");
  assert.equal(repairs.length, 1);
  const shown = runFixtureChild('pullboard', ['show', String(repairs[0].item_id)], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /main red: affected case \[G1\]:/u);
  assert.match(shown.stdout, /Expected values to be strictly equal/u);
});


test('JUnit failures retain decoded names and the first diagnostic line [C7]', () => {
  const output = '<testsuite><testcase name="first &amp; case"><failure message="expected &lt;one&gt;"/></testcase><testcase name="second"><error>bad value\nstack</error></testcase></testsuite>';
  assert.deepEqual(baselineFailureDetails(output), [
    { name: 'first & case', error: 'expected <one>' }, { name: 'second', error: 'bad value' },
  ]);
});
