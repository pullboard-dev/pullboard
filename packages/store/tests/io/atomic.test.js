/** @pullboard-test-input source-cell packages/store */
/** @pullboard-world-pin: clause 2 reads the two store writers' import lines, which are the subject of the claim. */
/** The one state-file writer: whole bytes by rename, and a failed rename leaves no torn or stray file [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { writeFileAtomic } from '../../src/io/atomic.js';

/** A fresh folder removed when the test ends. */
function folder(t) {
  const dir = privateFixtureFiles('pb-atomic-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('store.atomic.write-file-atomic-replaces-a-file-whole: #10494 clause 1: writeFileAtomic replaces a file whole, privately, and leaves no temporary sibling [C7]', t => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, 'old');
  writeFileAtomic(file, '{"new":true}\n');
  assert.equal(readFileSync(file, 'utf8'), '{"new":true}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('store.atomic.a-rename-failure-shows-no-torn-file: #10494 clause 1: a rename failure shows no torn file: the target is untouched and the temporary file is gone [C7]', t => {
  const dir = folder(t);
  const target = join(dir, 'state');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'kept');
  assert.throws(() => writeFileAtomic(target, 'half-written'), error => error.syscall === 'rename');
  assert.deepEqual(readdirSync(dir), ['state']);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'kept');
});

test('store.atomic.a-write-failure-leaves-the-target: #10494 clause 1: a write failure leaves the existing target as it was [C7]', t => {
  const dir = folder(t);
  const file = join(dir, 'missing', 'state.json');
  assert.throws(() => writeFileAtomic(file, 'x'), { code: 'ENOENT' });
  const kept = join(dir, 'state.json');
  writeFileSync(kept, 'kept');
  assert.throws(() => writeFileAtomic(kept, 'x', { mode: 'bad' }));
  assert.equal(readFileSync(kept, 'utf8'), 'kept');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('store.atomic.the-two-writers-import-it-from-the-store: #10494 clause 2: the board writer and the file write queue import writeFileAtomic from the store atomic.js, never from the kernel [C7,CD31]', () => {
  for (const file of ['../../src/io/board/write.js', '../../src/io/write-queue-file.js']) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const line = source.split('\n').find(row => /import \{ writeFileAtomic \}/u.test(row));
    assert.ok(line, `${file} imports writeFileAtomic`);
    assert.match(line, /from ["'](?:\.\.?\/)atomic\.js["']/u, `${file} imports it from the store atomic.js`);
  }
});
