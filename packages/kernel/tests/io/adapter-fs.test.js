/** @pullboard-test-input source-cell packages/kernel */
/** The file-system adapter returns the injected source, or the real one by default [C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as light from '../../light.js';
import { test } from 'node:test';
import { fileSystemAdapter } from '../../src/io/fs.js';

test('kernel.adapter-fs.returns-the-source: clause 1: the adapter returns what the injected source returns [C7]', () => {
  const files = { '/a': 'one' };
  const fs = fileSystemAdapter({
    readFileSync: (p) => files[p],
    writeFileSync: (p, d) => { files[p] = d; },
    existsSync: (p) => p in files,
    readdirSync: () => Object.keys(files),
  });
  assert.equal(fs.readFile('/a'), 'one');
  fs.writeFile('/b', 'two');
  assert.equal(fs.exists('/b'), true);
  assert.equal(fs.exists('/c'), false);
  assert.deepEqual(fs.list('/'), ['/a', '/b']);
});

test('kernel.adapter-fs.real-by-default: clause 1: the adapter reads the real source by default [C7]', () => {
  const file = fileURLToPath(import.meta.url);
  const fs = fileSystemAdapter();
  assert.match(fs.readFile(file), /file-system adapter returns/);
  assert.equal(fs.exists(file), true);
  assert.ok(fs.list(dirname(file)).includes('adapter-fs.test.js'));
});

test('kernel.adapter-fs.fake-is-deterministic: clause 1: a fake source makes the answer deterministic [C7]', () => {
  const fs = fileSystemAdapter({ readFileSync: () => 'fixed', existsSync: () => true });
  assert.equal(fs.readFile('/anything'), 'fixed');
  assert.equal(fs.readFile('/else'), 'fixed');
});

test('kernel.adapter-fs.not-imported-outside: clause 2: the runner light door does not export the adapter, so no existing behaviour changes [C7]', () => {
  assert.equal('fileSystemAdapter' in light, false);
  assert.equal(typeof fileSystemAdapter, 'function');
});
