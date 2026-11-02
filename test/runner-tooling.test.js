import { committedRunnerController, observeDirtyRunnerTooling, dirtyToolingFindings } from '../packages/runners/index.js';
import { utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
/** Dirty tooling is never execution authority; registered protocol checks use committed bytes [O5,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from './e2e-helpers.js';
import { copyPackageFiles } from '../packages/runners/src/shell/package-files.js';
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
assert.equal(result.executionSource.tooling.kind,'git-checkout');
assert.equal(result.executionSource.tooling.commit,${JSON.stringify(commit)});
console.log('DIRTY_TOOLING_CHECK_PASSED');`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project, env: box.env, encoding: 'utf8', timeout: 120_000,
  }); // Budget: ordinary fixture protocol and cleanup must finish within the existing per-test cap.
  assert.equal(result.status, 0, result.context);
  assert.match(result.stdout, /DIRTY_TOOLING_CHECK_PASSED/u);
  const dirty = 'UNCOMMITTED TOOLING IS NOT JAVASCRIPT {';
  const dirtyObject = createHash('sha1').update(`blob ${Buffer.byteLength(dirty)}\0${dirty}`).digest('hex');
  assert.equal(box.git(tooling, 'hash-object', 'src/runner-worker.js'), dirtyObject, 'the dirty working entry stays untouched');
  const attempts = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(attempts.length, 1, 'exactly one runner execution, without retrying dirty source');
  assert.equal(attempts[0].workerStarted, true);
  assert.equal(attempts[0].code, 0);
});


test('dirty tooling observation ages staged paths and retains rename sources independently [O5,C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), root = join(box.dir, 'tooling');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  const file = join(root, 'src/worker.js');
  writeFileSync(file, 'export const original = true;\n');
  box.git(root, 'init', '-q', '-b', 'main');
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'test: observer history');
  writeFileSync(file, 'export const changed = true;\n');
  utimesSync(file, new Date(0), new Date(0));
  box.git(root, 'add', '-A');
  const stagedAt = Date.now();
  assert.deepEqual(observeDirtyRunnerTooling(new Date(stagedAt), [], root), [], 'old file mtime cannot age a newly staged change');
  assert.equal(observeDirtyRunnerTooling(new Date(stagedAt + 300_001), [], root).length, 1);
  box.git(root, 'commit', '-q', '-m', 'test: staged change');
  box.git(root, 'mv', 'src/worker.js', 'docs/worker.md');
  const renamedAt = Date.now();
  assert.deepEqual(observeDirtyRunnerTooling(new Date(renamedAt), [], root), []);
  assert.match(observeDirtyRunnerTooling(new Date(renamedAt + 300_001), [], root)[0].title, /src\/worker\.js/u, 'renaming out of the tooling tree still names the removed source');
  writeFileSync(join(root, 'src/untracked.js'), '// new tooling\n');
  writeFileSync(join(root, 'docs/unrelated.md'), 'unrelated\n');
  const untrackedAt = Date.now();
  const findings = observeDirtyRunnerTooling(new Date(untrackedAt + 300_001), [], root);
  assert.ok(findings.some(row => row.title.includes('src/untracked.js')));
  assert.ok(findings.every(row => !row.title.includes('docs/unrelated.md')));
  const mixed = dirtyToolingFindings(root, [{ path: 'src/old.js', changedAt: 0 }, { path: 'src/new.js', changedAt: 400_000 }], new Date(400_001));
  assert.equal(mixed.length, 1, 'a new dirty path cannot borrow an older path age');
  assert.match(mixed[0].title, /src\/old\.js/u);
});

test('archived tooling still refuses modified archive bytes [O5,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), root = join(box.dir, 'tooling');
  mkdirSync(root);
  copyPackageFiles(resolve(import.meta.dirname, '..'), root);
  box.git(root, 'init', '-q', '-b', 'main');
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'test: immutable archive control');
  const archive = committedRunnerController(root);
  t.after(archive.cleanup);
  const worker = join(archive.root, 'src/runner-worker.js');
  writeFileSync(worker, readFileSync(worker, 'utf8') + '\n// altered archive bytes\n');
  const script = `import assert from 'node:assert/strict';
const {trustedTooling}=await import(${JSON.stringify(pathToFileURL(join(archive.root, 'packages/runners/index.js')).href)});
assert.throws(()=>trustedTooling(),{code:'RUNNER_TOOLING_CHANGED'});`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], { env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
});
