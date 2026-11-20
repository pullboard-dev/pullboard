/** The runner worker's import closure stays narrow [C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../src/io/package.js';
import { workerEntry } from '../src/io/package.js';

/**
 * The adapter front doors the worker may reach: the env and fs cells are the one place that reads process.env and node:fs,
 * and the worker-imports baseline already lists both units. Each door re-exports one adapter file, so it adds two files [C7].
 */
const ADAPTER_DOORS = ['packages/env/index.js', 'packages/fs/index.js'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('runners.runner-tooling-transfer.worker-closure-has-no-packages-index: worker closure has no packages/*/index.js [C7]', () => {
  const entry = workerEntry(root);
  const files = Object.keys(runnerPackage(root, entry).files);
  const doors = files.filter(file => /^packages\/[^/]+\/index\.js$/u.test(file));
  assert.deepEqual(doors.filter(file => !ADAPTER_DOORS.includes(file)), []);
  for (const door of doors) {
    const cell = door.slice(0, -'index.js'.length);
    const inCell = files.filter(file => file.startsWith(cell));
    assert.equal(inCell.length, 2, `${door} re-exports one adapter file and pulls nothing else of its cell: ${inCell.join(', ')}`);
  }
});
