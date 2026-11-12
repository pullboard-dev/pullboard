/** @pullboard-test-input packages/runners/index.js */
/** @pullboard-test-loads packages/runners/src/shell/runner-tooling-snapshot.js packages/runners/src/shell/runner-package.js packages/runners/src/shell/runner-module-parser.js packages/runners/src/shell/runner-module-parser-worker.js */
/** The tooling snapshot reads the controller and worker entries of a 0.9.3 tree, and of a tree after the move [C7,V32]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { workerEntry } from '../../../src/io/package.js';
import { captureRunnerTooling } from '../../../src/io/tooling/snapshot.js';
import { currentRunnerTooling } from '../../../src/io/tooling/snapshot.js';

/** Isolated tree holding the named files; removed with the test. */
function tree(t, files) {
  const scratch = privateFixtureFiles('pullboard-legacy-layout-');
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));
  scratch.write('package.json', JSON.stringify({ type: 'module', files: ['src', 'apps', 'packages/*/src', 'packages/*/index.js'] }));
  scratch.write('bin/runner-controller.js', 'export const composition = true;\n');
  scratch.write('packages/leaf/src/value.js', 'export const value = 42;\n');
  for (const [file, text] of Object.entries(files)) scratch.write(file, text);
  return { root: scratch.root, write: scratch.write };
}

test('a 0.9.3-layout tree holding src/runners.js and src/runner-worker.js pins both as before [C7,V32]', t => {
  const f = tree(t, {
    'src/runner-worker.js': "import '../packages/leaf/src/value.js';\n",
    'src/runners.js': 'export const controller = true;\n',
    'packages/runners/index.js': 'export const door = true;\n',
  });
  assert.equal(workerEntry(f.root), 'src/runner-worker.js');
  const loaded = captureRunnerTooling(f.root);
  assert.equal(loaded.entry, 'src/runner-worker.js');
  assert.equal(loaded.controller, readFileSync(join(f.root, 'src/runners.js'), 'utf8'));
  assert.ok(currentRunnerTooling(f.root, loaded));
  f.write('src/runners.js', 'export const controller = false;\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED');
});

test('a tree without the old paths pins the controller from packages/runners and the worker from its cell [C7,V32]', t => {
  const f = tree(t, {
    'apps/runner/runner-worker.js': "import '../../packages/leaf/src/value.js';\n",
    'packages/runners/index.js': 'export const door = true;\n',
  });
  assert.equal(workerEntry(f.root), 'apps/runner/runner-worker.js');
  const loaded = captureRunnerTooling(f.root);
  assert.equal(loaded.entry, 'apps/runner/runner-worker.js');
  assert.equal(loaded.controller, readFileSync(join(f.root, 'packages/runners/index.js'), 'utf8'));
  assert.ok(currentRunnerTooling(f.root, loaded));
  f.write('packages/runners/index.js', 'export const door = false;\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED');
});

test('the controller providers are the packages its real imports reach, and their bytes move the pin [C7,V32]', t => {
  const f = tree(t, {
    'apps/runner/runner-worker.js': "import '../../packages/leaf/src/value.js';\n",
    'apps/runner/src/io/controller.js': "import '../../../../packages/runners/index.js';\nimport '../../../../packages/provider/index.js';\n",
    'packages/runners/index.js': 'export const door = true;\n',
    'packages/provider/index.js': 'export const provided = true;\n',
  });
  const loaded = captureRunnerTooling(f.root);
  assert.ok(loaded.controllerProviders, 'the controller names providers');
  assert.ok(currentRunnerTooling(f.root, loaded));
  f.write('packages/provider/index.js', 'export const provided = false;\n');
  assert.throws(() => currentRunnerTooling(f.root, loaded), error => error.code === 'RUNNER_TOOLING_CHANGED', 'a provider body the controller imports changes the pin');
});

test('a directory URL in the controller closure is skipped, not refused as RUNNER_TOOLING_FILES on . [C7,V32]', t => {
  const f = tree(t, {
    'apps/runner/runner-worker.js': "import '../../packages/leaf/src/value.js';\n",
    'packages/runners/index.js': "export const own = new URL('../..', import.meta.url);\nexport const src = new URL('../leaf/src', import.meta.url);\n",
  });
  const loaded = captureRunnerTooling(f.root);
  assert.equal(loaded.controller, readFileSync(join(f.root, 'packages/runners/index.js'), 'utf8'));
  assert.ok(currentRunnerTooling(f.root, loaded));
});

test('capture succeeds on the real tree [C7,V32]', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const loaded = captureRunnerTooling(root);
  assert.ok(loaded.controller.length > 0 && loaded.files);
});

test('dynamic-base URLs, computed requires and runtime-only files are skipped, literal ones kept [C7,V32]', t => {
  const f = tree(t, {
    'apps/runner/runner-worker.js': "import '../../packages/leaf/src/value.js';\n",
    'packages/runners/index.js': "import { createRequire } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nconst r = createRequire(import.meta.url);\nr('../leaf/src/value.js');\nexport const a = new URL('x.js', pathToFileURL('/tmp/'));\nexport const m = new URL('../../.pullboard-runner-source.json', import.meta.url);\nexport const c = (n) => r(n);\n",
  });
  const loaded = captureRunnerTooling(f.root);
  assert.ok(loaded.files['packages/leaf/src/value.js']);
});
