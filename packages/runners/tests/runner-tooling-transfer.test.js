/** The runner worker's import closure stays narrow [C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../src/io/package.js';
import { workerEntry } from '../src/io/package.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('runners.runner-tooling-transfer.worker-closure-has-no-packages-index: worker closure has no packages/*/index.js [C7]', () => {
  const entry = workerEntry(root);
  const files = Object.keys(runnerPackage(root, entry).files);
  assert.deepEqual(files.filter(file => /^packages\/[^/]+\/index\.js$/u.test(file)), []);
});
