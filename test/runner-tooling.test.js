/** Dirty tooling is never execution authority; registered protocol checks use committed bytes [O5,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from './e2e-helpers.js';
import { copyPackageFiles } from '../src/package-files.js';
import { runFixtureChildAsync } from './fixture-child.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';

test('a dirty main checkout does not stop a runner check [O5,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox();
  const tooling = join(box.dir, 'tooling'), project = join(box.dir, 'project');
  const worker = join(box.dir, 'worker'), home = join(box.dir, 'worker-home');
  const machineHome = join(home, '.pullboard'), requests = join(box.dir, 'requests.jsonl');
  for (const root of [tooling, project, worker, home, machineHome]) mkdirSync(root, { recursive: true });
  copyPackageFiles(resolve(import.meta.dirname, '..'), tooling);
  writeFileSync(join(project, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  for (const root of [tooling, project]) {
    box.git(root, 'init', '-q', '-b', 'main');
    box.git(root, 'add', '-A');
    box.git(root, 'commit', '-q', '-m', 'test: immutable tooling fixture');
  }
  const commit = box.git(tooling, 'rev-parse', 'HEAD');
  // Invalid working bytes must neither execute nor be parsed to pack the selected tooling.
  writeFileSync(join(tooling, 'src/runner-worker.js'), 'UNCOMMITTED TOOLING IS NOT JAVASCRIPT {');
  installSshStandIn({ bin: join(box.dir, 'bin'), worker, home, machineHome, requests });
  const script = `import assert from 'node:assert/strict';
const {runOnRunnerAsync}=await import(${JSON.stringify(pathToFileURL(join(tooling, 'src/runners.js')).href)});
const result=await runOnRunnerAsync(process.cwd(), 'node -e "console.log(12345)"', {runner:{host:${JSON.stringify(HOST)},slots:1,browser:0}});
assert.equal(result.isGreen,true,JSON.stringify(result));
assert.match(result.output,/12345/u);
assert.equal(result.profile.executionSource.tooling.kind,'git-checkout');
assert.equal(result.profile.executionSource.tooling.commit,${JSON.stringify(commit)});
console.log('DIRTY_TOOLING_CHECK_PASSED');`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project, env: box.env, encoding: 'utf8', timeout: 120_000,
  }); // Budget: ordinary fixture protocol and cleanup must finish within the existing per-test cap.
  assert.equal(result.status, 0, result.context);
  assert.match(result.stdout, /DIRTY_TOOLING_CHECK_PASSED/u);
  assert.equal(readFileSync(join(tooling, 'src/runner-worker.js'), 'utf8'), 'UNCOMMITTED TOOLING IS NOT JAVASCRIPT {');
  const attempts = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(attempts.length, 1, 'exactly one runner execution, without retrying dirty source');
  assert.equal(attempts[0].workerStarted, true);
  assert.equal(attempts[0].code, 0);
});
