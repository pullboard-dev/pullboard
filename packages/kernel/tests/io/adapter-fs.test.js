/** The file-system adapter returns the injected source, or the real one by default [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fileSystemAdapter } from '../../src/io/fs.js';

test('clause 1: the adapter returns what the injected source returns [C7]', () => {
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

test('clause 1: the adapter reads the real source by default [C7]', () => {
  const file = fileURLToPath(import.meta.url);
  const fs = fileSystemAdapter();
  assert.match(fs.readFile(file), /file-system adapter returns/);
  assert.equal(fs.exists(file), true);
  assert.ok(fs.list(dirname(file)).includes('adapter-fs.test.js'));
});

test('clause 1: a fake source makes the answer deterministic [C7]', () => {
  const fs = fileSystemAdapter({ readFileSync: () => 'fixed', existsSync: () => true });
  assert.equal(fs.readFile('/anything'), 'fixed');
  assert.equal(fs.readFile('/else'), 'fixed');
});

test('clause 2: nothing outside packages/kernel imports the adapter yet [C7]', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const hits = spawnSync('git', ['grep', '-l', 'fileSystemAdapter', '--', '.', ':!packages/kernel'], { cwd: root, encoding: 'utf8' });
  assert.equal(hits.stdout.trim(), '', 'no importer outside the kernel');
});
