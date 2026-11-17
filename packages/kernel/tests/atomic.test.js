/** @pullboard-test-input packages/kernel/src/logic/atomic.js */
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
import { privateFixtureFiles } from '../../gate/tests/fixtures/child.js';
import { writeFileAtomic } from '../light.js';

/** A fresh folder removed when the test ends. */
function folder(t) {
  const dir = privateFixtureFiles('pb-atomic-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('kernel.atomic.write-file-atomic-replaces-a-file-whole: #6740 clause 1: writeFileAtomic replaces a file whole, privately, and leaves no temporary sibling [C7]', t => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, 'old');
  writeFileAtomic(file, '{"new":true}\n');
  assert.equal(readFileSync(file, 'utf8'), '{"new":true}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('kernel.atomic.a-rename-failure-shows-no-torn-file: #6740 clause 1: a rename failure shows no torn file: the target is untouched and the temporary file is gone [C7]', t => {
  const dir = folder(t);
  const target = join(dir, 'state');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'kept');
  assert.throws(() => writeFileAtomic(target, 'half-written'), error => error.syscall === 'rename');
  assert.deepEqual(readdirSync(dir), ['state']);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'kept');
});

test('kernel.atomic.a-write-failure-leaves-the-target: #6740 clause 1: a write failure leaves the existing target as it was [C7]', t => {
  const dir = folder(t);
  const file = join(dir, 'missing', 'state.json');
  assert.throws(() => writeFileAtomic(file, 'x'), { code: 'ENOENT' });
  const kept = join(dir, 'state.json');
  writeFileSync(kept, 'kept');
  assert.throws(() => writeFileAtomic(kept, 'x', { mode: 'bad' }));
  assert.equal(readFileSync(kept, 'utf8'), 'kept');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});
