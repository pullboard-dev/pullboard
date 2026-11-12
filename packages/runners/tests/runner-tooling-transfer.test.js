/** The runner worker's import closure stays narrow and inside its recorded size ceiling [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../src/io/package.js';
import { workerBundleBytes } from '../src/io/package.js';
import { workerEntry } from '../src/io/package.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('worker closure has no packages/*/index.js, bytes <= ceiling [C7]', () => {
  const entry = workerEntry(root);
  const files = Object.keys(runnerPackage(root, entry).files);
  assert.deepEqual(files.filter(file => /^packages\/[^/]+\/index\.js$/u.test(file)), []);
  const ceiling = JSON.parse(readFileSync(join(root, 'packages/gate/data/ceilings/worker-bundle.json'), 'utf8')).bytes;
  assert.ok(workerBundleBytes(root, entry) <= ceiling, `worker bundle exceeds ceiling ${ceiling}`);
});
