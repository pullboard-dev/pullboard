/** Private flake readers preserve actual evidence and cannot acquire source-file authority [C7,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { flakyProject } from './fixtures/flakes.js';

test('private flake evidence keeps real bytes and refuses source paths and symlinks [C7,H16]', t => {
  const box = flakyProject(t);
  writeFileSync(box.counter, 'actual counter bytes\n');
  assert.equal(box.readData(box.counter, 'utf8'), 'actual counter bytes\n');
  const evidence = join(box.root, '.git/pullboard');
  mkdirSync(evidence, { recursive: true });
  const file = join(evidence, 'reader-check.log');
  writeFileSync(file, 'first actual evidence\n');
  assert.deepEqual(box.readData(file), Buffer.from('first actual evidence\n'));
  writeFileSync(file, 'changed actual evidence\n');
  assert.equal(box.readData(file, 'utf8'), 'changed actual evidence\n');
  const source = join(box.root, 'test/alternating.test.mjs');
  assert.throws(() => box.readData(source), /escaped/u);
  assert.throws(() => box.readData(join(evidence, '../../test/alternating.test.mjs')), /escaped/u);
  assert.throws(() => box.readData('reader-check.log'), /absolute/u);
  symlinkSync(source, join(evidence, 'source-link'));
  assert.throws(() => box.readData(join(evidence, 'source-link')), /regular file/u);
  symlinkSync(box.root, join(evidence, 'ancestor-link'), 'dir');
  assert.throws(() => box.readData(join(evidence, 'ancestor-link/test/alternating.test.mjs')), /regular file/u);
});
