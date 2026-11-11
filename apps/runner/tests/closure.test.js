/** @pullboard-test-input source-tree package.json */
/** The worker includes the artifact receiver without loading the controller [C7]. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runnerWorkerFiles } from '../../../packages/codemap/index.js';
import { commonJsIn } from '../../../packages/gate/index.js';
import { importsIn } from '../../../packages/gate/index.js';
import { packageFiles } from '../../../packages/runners/index.js';
import { runnerPackage } from '../../../packages/runners/index.js';

test('worker closure contains the artifact protocol without controller initialization [C7]', () => {
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
