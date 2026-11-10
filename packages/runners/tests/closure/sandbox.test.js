/** @pullboard-test-input source-tree package.json */
/** The sandbox shims keep the runner worker closure resolvable and off the engine [C7,CD60]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../../index.js';

test('runnerPackage resolves and the worker closure does not reach the sandbox front door or engine bodies [C7,CD60]', () => {
  const root = dirname(fileURLToPath(new URL('../../../../package.json', import.meta.url)));
  const capsule = runnerPackage(root);
  assert.equal(capsule.entry, 'apps/runner/src/io/scripts/worker.js');
  for (const file of ['packages/sandbox/index.js', 'packages/sandbox/src/io/source/advance.js',
    'packages/sandbox/src/io/source/advance/worker.js', 'packages/state/src/io/engine/metadata.js', 'packages/store/src/io/board/reopen.js']) {
    assert.ok(!Object.hasOwn(capsule.files, file), `the runner worker must not import ${file}`);
  }
  assert.ok(Object.keys(capsule.files).length > 0 && Buffer.byteLength(JSON.stringify(capsule.files)) < 1_048_576);
});
