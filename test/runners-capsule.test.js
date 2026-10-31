/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assert,
  dirname,
  join,
  packageFiles,
  relative,
  resolve,
  runnerPackage,
  sep,
  test,
} from './runners-scenarios.fixture.js';

test("the runner's computed capsule is closed under its relative imports [C7,O5]", () => {
  const root = resolve(import.meta.dirname, '..');
  const capsule = runnerPackage(root);
  const allowed = new Set(packageFiles(root));
  assert.equal(capsule.entry, 'src/runner-worker.js');
  for (const [file, text] of Object.entries(capsule.files)) {
    assert.ok(allowed.has(file), `${file} belongs to the shipped manifest`);
    for (const [, target] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)'(\.\.?\/[^']+)'/gmu)) {
      const dependency = relative(root, resolve(root, dirname(file), target)).split(sep).join('/');
      assert.ok(Object.hasOwn(capsule.files, dependency), `${file} imports ${target}, which must reach the capsule`);
    }
  }
});

test('the moved runner load shim keeps unrelated front-door modules out of the worker capsule [C7]', () => {
  const root = resolve(import.meta.dirname, '..');
  const files = runnerPackage(root).files;
  assert.ok(Object.hasOwn(files, 'src/runner-load.js'));
  assert.ok(Object.hasOwn(files, 'packages/runners/src/shell/runner-load.js'));
  assert.ok(Object.hasOwn(files, 'packages/runners/src/shell/runner-policy.js'));
  assert.ok(Object.hasOwn(files, 'packages/runners/src/shell/runner-overhead.js'));
  assert.equal(Object.hasOwn(files, 'packages/runners/index.js'), false);
  assert.equal(Object.hasOwn(files, 'packages/runners/src/core/runner-stage-model.js'), false);
});
