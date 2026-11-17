/** @pullboard-test-input package.json apps/runner/src/io/scripts/worker.js apps/runner/src/io/worker.js packages/resources/src/io/artifact.js packages/runners/src/io/main.js */
/** The worker includes the artifact receiver without loading the controller [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runnerWorkerFiles } from '../../../packages/codemap/index.js';
import { commonJsIn } from '../../../packages/gate/index.js';
import { importsIn } from '../../../packages/gate/index.js';
import { packageFiles } from '../../../packages/runners/index.js';
import { runnerPackage } from '../../../packages/runners/index.js';
import { trustedWorkerEntry } from '../../../packages/runners/light.js';

test('runner.closure.worker-closure-contains-the-artifact-protocol-without: worker closure contains the artifact protocol without controller initialization [C7]', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const worker = runnerWorkerFiles(root, { importsIn, commonJsIn, files: packageFiles(root) });
  const capsule = runnerPackage(root);
  for (const files of [worker, new Set(Object.keys(capsule.files))]) {
    assert.ok(files.has('apps/runner/src/io/scripts/worker.js'));
    assert.ok(files.has('apps/runner/src/io/worker.js'));
    assert.ok(files.has('packages/resources/src/io/artifact.js'));
    assert.equal(files.has('packages/runners/src/io/main.js'), false, 'worker does not load controller initialization');
  }
});

test('runner.closure.the-trusted-runtime-check-accepts-the-legacy: the trusted-runtime check accepts the legacy worker entry and the new one; any other entry is refused [C7]', () => {
  assert.equal(trustedWorkerEntry('apps/runner/src/io/scripts/worker.js'), true, 'legacy entry (0.9.3 manifests)');
  assert.equal(trustedWorkerEntry('apps/runner/runner-worker.js'), true, 'new entry');
  for (const other of ['apps/runner/src/io/worker.js', '../apps/runner/runner-worker.js', 'package.json', '', undefined]) {
    assert.equal(trustedWorkerEntry(other), false, `any other entry is refused: ${other}`);
  }
});
