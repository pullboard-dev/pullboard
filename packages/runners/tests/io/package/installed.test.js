/** @pullboard-test-input apps/runner/src/io/controller.js apps/runner/src/io/scripts/worker.js packages/resources/src/io/controller/custody.js packages/resources/src/io/main.js packages/runners/src/io/module/parser/worker.js packages/state/src/logic/engines/check-timing-engine.js */
/** @pullboard-test-loads packages/runners/src/io/tooling/snapshot.js packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/index.js */
/** Private shipped-source fixtures for an installed worker and the actual controller; these tests do not claim execution on a physical runner [C7,P3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runnerPackage } from '../../../src/io/package.js';
import { captureRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { currentRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { installRunnerPackage } from '../../../src/io/package/install.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyRunnerPackage } from '../../fixtures/package.js';
import { toolSourcePath } from '../../../index.js';
import { fixture } from '../../fixtures/package-files.js';
import { controllerFixture } from '../../fixtures/package-files.js';

test('runners.installed.a-loaded-controller-refuses-changed-private: a loaded controller refuses changed private compiler bytes before an optional rescan [C7,P3]', async t => {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyRunnerPackage(resolve(import.meta.dirname, '../../../../..'), installed);
  const snapshot = await import(pathToFileURL(join(installed, 'packages/runners/src/io/tooling/snapshot.js')).href);
  const loaded = snapshot.captureRunnerTooling(installed);
  for (const file of ['packages/runners/src/io/module/parser.js', 'packages/runners/src/io/module/parser/worker.js']) {
    const path = toolSourcePath(installed, file);
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n// changed after actual installed module load\n')]));
      assert.throws(() => snapshot.currentRunnerTooling(installed, loaded, { rescan: false }),
        error => error.code === 'RUNNER_TOOLING_CHANGED', 'the new controller-only compiler pair is guarded before rescanning');
    } finally { writeFileSync(path, original); }
  }
  assert.deepEqual(snapshot.currentRunnerTooling(installed, loaded), runnerPackage(installed));
});

test('runners.installed.an-installed-worker-follows-node-import: an installed worker follows Node import-pattern prefix precedence [C7,P3]', t => {
  const f = fixture(t, ['src', 'apps', 'packages']);
  f.write('package.json', JSON.stringify({ type: 'module', files: ['src', 'apps', 'packages'], imports: {
    '#a/*/long': './packages/less/src/*.js', '#a/b/*': './packages/more/src/*.js',
  } }));
  f.write('apps/runner/src/io/scripts/worker.js', "import {value} from '#a/b/value/long'; console.log(value);\n");
  f.write('packages/less/src/b/value.js', "export const value = 'wrong-pattern';\n");
  f.write('packages/more/src/value/long.js', "export const value = 'longest-prefix';\n");
  const capsule = runnerPackage(f.root);
  assert.ok(Object.hasOwn(capsule.files, 'packages/more/src/value/long.js'));
  assert.equal(Object.hasOwn(capsule.files, 'packages/less/src/b/value.js'), false);
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const result = runFixtureChild(process.execPath, [join(runner, 'runtime', digest, capsule.entry)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'longest-prefix');
});

test('runners.installed.an-installed-worker-executes-a-prefix: an installed worker executes a prefix-only Node builtin without copying it [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); console.log(db.prepare('SELECT 42 AS value').get().value); db.close();\n");
  const capsule = runnerPackage(f.root);
  assert.deepEqual(Object.keys(capsule.files), ['apps/runner/src/io/scripts/worker.js', 'package.json']);
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const result = runFixtureChild(process.execPath, [join(runner, 'runtime', digest, capsule.entry)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42', 'the genuine builtin executes in the installed worker');
});

test('runners.installed.an-installed-worker-executes-coverage-with: an installed worker executes coverage with its source-relative reporter dependency [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/reporter.js', "export default async function* report(events) { for await (const event of events) if(event.type==='test:coverage') yield 'REAL_COVERAGE\\n'; }\n");
  const bodyMarker = join(f.directory, 'coverage-body.json');
  f.write('apps/runner/src/io/scripts/worker.js', `import {test} from 'node:test'; import {writeFileSync} from 'node:fs'; const reporter = new URL('./reporter.js', import.meta.url); test('private coverage',()=>writeFileSync(${JSON.stringify(bodyMarker)},JSON.stringify({executed:true,node:process.version}))); console.log(reporter.pathname);\n`);
  const capsule = runnerPackage(f.root);
  assert.ok(Object.hasOwn(capsule.files, 'apps/runner/src/io/scripts/reporter.js'));
  const bytes = Buffer.from(JSON.stringify(capsule.files));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = join(f.directory, 'runner');
  installRunnerPackage(gzipSync(bytes).toString('base64'), digest, runner);
  const installed = join(runner, 'runtime', digest);
  const env = { ...process.env };
  // This independent Node test command must not inherit its parent's test harness context (#1390).
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--test', '--experimental-test-coverage',
    `--test-reporter=${join(installed, 'apps/runner/src/io/scripts/reporter.js')}`, join(installed, capsule.entry)], { env, encoding: 'utf8' });
  const diagnostic = `${result.context}\nstdout: ${(result.stdout ?? '').slice(-4096)}`;
  assert.equal(result.status, 0, diagnostic);
  assert.match(result.stdout, /REAL_COVERAGE/u, `the installed reporter consumes real native coverage events\n${diagnostic}`);
  const body = JSON.parse(readFileSync(bodyMarker, 'utf8'));
  assert.equal(body.executed, true, 'the actual private test body ran, not merely the launcher');
  assert.match(body.node, /^v\d+\./u);
});

test('runners.installed.a-loaded-controller-refuses-changes-to: a loaded controller refuses changes to every derived runtime file before rescanning [C7,P3]', t => {
  const f = fixture(t);
  f.write('apps/runner/src/io/scripts/worker.js', "import '../../../../../packages/leaf/src/value.js';\n");
  f.write('packages/runners/index.js', 'export const controller = true;\n');
  f.write('apps/runner/src/io/controller.js', 'export const composition = true;\n');
  const loaded = captureRunnerTooling(f.root);
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
  for (const [file, original] of Object.entries(loaded.files)) {
    f.write(file, original + '\nnot valid JavaScript or JSON @@@');
    assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED', file);
    f.write(file, original);
  }
  f.write('packages/runners/index.js', loaded.controller + '\n// a different controller generation\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED');
  f.write('packages/runners/index.js', loaded.controller);
  f.write('apps/runner/src/io/controller.js', loaded.controllerEntry + '\n// a different native composition generation\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded, { rescan: false }), error => error.code === 'RUNNER_TOOLING_CHANGED');
  f.write('apps/runner/src/io/controller.js', loaded.controllerEntry);
  assert.deepEqual(currentRunnerTooling(f.root, loaded), runnerPackage(f.root));
});

test('runners.installed.controller-provider-freshness-follows-its-real: controller provider freshness follows its real package composition, not unrelated shipped engine leaves [C7,P3]', t => {
  const { installed } = controllerFixture(t);
  const loaded = captureRunnerTooling(installed);
  const unrelated = join(installed, 'packages/state/src/logic/engines/engine-next.js'); // check-timing-engine.js is composed through the state light door
  writeFileSync(unrelated, readFileSync(unrelated, 'utf8') + '\n// unrelated private generation\n');
  assert.deepEqual(currentRunnerTooling(installed, loaded), runnerPackage(installed),
    'an unrelated shipped file is not part of this controller generation');
  const provider = join(installed, 'packages/resources/src/io/controller/custody.js');
  writeFileSync(provider, readFileSync(provider, 'utf8') + '\n// actual composed provider changed\n');
  assert.throws(() => currentRunnerTooling(installed, loaded), { code: 'RUNNER_TOOLING_CHANGED' },
    'the actual transitive lifecycle provider still requires a fresh controller');
});

test('runners.installed.the-actual-async-controller-retains-fresh: the actual async controller retains fresh bridging and rejects a stale derived runtime before dispatch [C7,P3]', t => {
  const f = controllerFixture(t);
  const script = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
const {runOnRunnerAsync}=await import(${JSON.stringify(pathToFileURL(join(f.installed, 'packages/runners/index.js')).href)});
const options={runner:{host:'private-unused.invalid',slots:1,browser:0}};
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',options),error=>error.code==='RUNNER_SOURCE_CHANGED');
const resource=${JSON.stringify(toolSourcePath(f.installed, 'packages/resources/src/io/main.js'))};
writeFileSync(resource,readFileSync(resource,'utf8')+'\\n// changed after controller load\\n');
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',options),error=>error.code==='RUNNER_TOOLING_CHANGED');`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
});

for (const kind of ['opaque', 'unshipped']) {
  test(`the actual async controller preserves ${kind} runtime refusal captured at load [C7,P3]`, t => {
    const f = controllerFixture(t);
    if (kind === 'opaque') {
      const worker = join(f.installed, 'apps/runner/src/io/scripts/worker.js');
      writeFileSync(worker, readFileSync(worker, 'utf8') + '\nrequire(unknownRuntime);\n');
    } else {
      const manifest = join(f.installed, 'package.json');
      const value = JSON.parse(readFileSync(manifest, 'utf8'));
      value.files = ['package.json'];
      writeFileSync(manifest, JSON.stringify(value));
    }
    const script = `import assert from 'node:assert/strict';
const {runOnRunnerAsync}=await import(${JSON.stringify(pathToFileURL(join(f.installed, 'packages/runners/index.js')).href)});
await assert.rejects(runOnRunnerAsync(process.cwd(),'true',{runner:{host:'private-unused.invalid',slots:1,browser:0}}),error=>error.code==='RUNNER_TOOLING_FILES');`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.context);
  });
}
