/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPackageFiles } from '../packages/runners/src/shell/package-files.js';
import { toolSourcePath } from '../packages/runners/src/shell/package-files.js';
import {
  assert,
  dirname,
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
  assert.ok(Object.hasOwn(files, 'packages/runners/src/shell/runner-transport.js'));
  assert.ok(Object.hasOwn(files, 'packages/runners/src/shell/runner-source-cache.js'));
  assert.equal(Object.hasOwn(files, 'packages/runners/index.js'), false);
  assert.equal(Object.hasOwn(files, 'packages/runners/src/core/runner-stage-model.js'), false);
});

/** Compare real manifest-derived closures, allowing only the removed transparent compatibility hop. */
test('the runner policy exact-leaf exception preserves every worker body byte [C7]', t => {
  const installed = mkdtempSync(join(tmpdir(), 'pullboard-policy-closure-'));
  t.after(() => rmSync(installed, { recursive: true, force: true }));
  copyPackageFiles(resolve(import.meta.dirname, '..'), installed);
  const policy = 'packages/runners/src/shell/runner-policy.js';
  const leaf = 'packages/sandbox/src/shell/trusted-policy-read.js';
  const file = join(installed, policy);
  const after = runnerPackage(installed).files;
  const source = after[policy];
  const direct = "'../../../sandbox/src/shell/trusted-policy-read.js'";
  assert.ok(source.includes(direct));
  assert.equal(Object.hasOwn(after, 'src/trusted-policy-read.js'), false);
  assert.equal(Object.hasOwn(after, 'packages/sandbox/index.js'), false);
  assert.equal(after[leaf], readFileSync(toolSourcePath(installed, leaf), 'utf8'));
  try {
    writeFileSync(file, source.replace(direct, "'../../../../src/trusted-policy-read.js'"));
    const before = runnerPackage(installed).files;
    assert.ok(Object.hasOwn(before, 'src/trusted-policy-read.js'));
    const expected = { ...before, [policy]: source };
    delete expected['src/trusted-policy-read.js'];
    assert.deepEqual(after, expected, 'only the transparent shim and its import spelling may differ');
    writeFileSync(file, source.replace(direct, "'../../../sandbox/index.js'"));
    assert.throws(() => runnerPackage(installed), error => error.code === 'RUNNER_TOOLING_FILES'
      && error.message.includes('the import closure exceeds the 1 MiB transfer bound'),
    'the sandbox barrel expands the closure past the unchanged transfer bound');
  } finally { writeFileSync(file, source); }
});
