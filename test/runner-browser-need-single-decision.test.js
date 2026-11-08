/** @pullboard-test-input source-tree */
/** @pullboard-module-loads packages/gate/index.js packages/runners/index.js packages/landing/index.js */
/** Replay the frozen-check plus cockpit-proof file shapes from #2576 and #2521 on a real worker [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { awaitNestedRun } from '../packages/gate/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { copyCommittedPackageFiles } from './package-copy-fixture.js';
import { executionServicesSource } from './gate-execution-fixture.js';
import { runFixtureChildAsync } from './fixture-child.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';
import { cli, phaseCounts } from './runner-tooling-fixture.js';

const CHECK_FILES = ['test/cells-owned-stays.test.js', 'test/cells-plan-trunk-read.test.js'];
const PROOF_FILE = 'test/cockpit/activity-codegen.test.js';

/** Build small fixture bodies at the witnessed paths; this proves admission, not either historical item's behavior. */
function regressionSources(box) {
  mkdirSync(join(box.repo, 'test/cockpit'), { recursive: true });
  for (const file of CHECK_FILES) writeFileSync(join(box.repo, file),
    "import { test } from 'node:test';\ntest('private frozen check runs [C7]', () => {});\n");
  writeFileSync(join(box.repo, PROOF_FILE), "// pullboard: browser\nimport { test } from 'node:test';\n"
    + "import assert from 'node:assert/strict';\n"
    + "import { spawnSync } from 'node:child_process';\nconst chrome = 'google-chrome';\n"
    + "test('supplement has its admitted browser lease [C7]', () => { assert.equal(process.env.PULLBOARD_TEST_BROWSER_SLOT, 'held'); if (process.env.PULLBOARD_FIXTURE_NEVER_SET) spawnSync(chrome, ['--version']); });\n");
}

test('review file sets from #2576 and #2521 take a browser lease on their first runner attempt [C7]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  // This is an ordinary Node project; initialize Git before copying tooling, without installing Pullboard project hooks.
  const sandbox = e2e.sandbox();
  const box = { ...sandbox, repo: join(sandbox.dir, 'repo') };
  mkdirSync(box.repo);
  box.git(box.repo, 'init', '-q', '-b', 'main');
  for (const name of Object.keys(box.env)) {
    if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(name) || ['NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(name)) delete box.env[name];
  }
  box.env.PULLBOARD_TEST_REUSE = '0';
  copyCommittedPackageFiles(box, join(import.meta.dirname, '..'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  regressionSources(box);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: browser admission regression shapes [C7]');
  const [bin, worker, home] = ['ssh-bin', 'worker', 'worker-home'].map(name => join(box.dir, name));
  for (const folder of [bin, worker, home]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'ssh-requests.jsonl');
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const added = cli(box.repo, box.env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1');
  assert.equal(added.status, 0, added.context);
  const gate = pathToFileURL(join(box.repo, 'packages/gate/index.js')).href;
  const source = `import assert from 'node:assert/strict';
import { privateCheckAdmission, testsNeedBrowser, withGateSlot, runProfiledShell } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
const root = ${JSON.stringify(box.repo)};
const commit = ${JSON.stringify(box.git(box.repo, 'rev-parse', 'HEAD'))};
const proof = 'node bin/run-tests.js ${PROOF_FILE}';
for (const file of ${JSON.stringify(CHECK_FILES)}) {
  const check = 'node bin/run-tests.js ' + file;
  const options = { commit, allowBrowserFreeChecks: true };
  assert.equal((await privateCheckAdmission(root, [check], options)).browser, false);
  const admission = await privateCheckAdmission(root, [check, proof], options);
  assert.equal(admission.browser, true);
  assert.equal(await testsNeedBrowser(root, [file, ${JSON.stringify(PROOF_FILE)}], { commit }), admission.browser);
  assert.equal(await testsNeedBrowser(root, [file, ${JSON.stringify(PROOF_FILE)}]), admission.browser);
  const result = await withGateSlot(root, lease => {
    assert.equal(lease.browser, true);
    return runProfiledShell(root, check + ' && ' + proof, { gateLease: lease });
  }, { executionServices, ...admission, remote: true, runnerOnly: true, kind: 'review-browser-need', item: 'browser-need-fixture' });
  assert.equal(result.isGreen, true, result.output);
  assert.equal(result.profile.executionRunner, ${JSON.stringify(HOST)});
}
console.log('BROWSER_ADMISSION_FIRST_ATTEMPTS_COMPLETE');
`;
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env,
  }));
  assert.equal(result.status, 0, result.context + '\n' + result.stdout + '\n' + result.stderr);
  assert.match(result.stdout, /BROWSER_ADMISSION_FIRST_ATTEMPTS_COMPLETE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /BROWSER_SLOT_REQUIRED|RUNNER_BROWSER_SLOT_REQUIRED/u);
  assert.equal(phaseCounts(requests + '.phases').dispatched, CHECK_FILES.length,
    'one remote dispatch per historical file-set shape, with no browser retry');
});
