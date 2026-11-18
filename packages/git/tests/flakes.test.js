/** Private flake readers preserve actual evidence and cannot acquire source-file authority [C7,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellSandbox } from '../../store/tests/fixtures/cell.js';
import { evidenceReader } from './fixtures/evidence.js';

/** A private scratch with a repo source file and a counter, read only through the flake fixture's evidence reader; no CLI runs. */
function evidenceBox(t) {
  const scratch = cellSandbox(t).dir;
  const root = join(scratch, 'repo'), counter = join(scratch, 'observed-target-runs');
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test/alternating.test.mjs'), 'export {};\n');
  return { root, counter, readData: evidenceReader({ scratch, root, counter }) };
}

test('git.flakes.private-evidence: private flake evidence keeps real bytes and refuses source paths and symlinks [C7,H16]', t => {
  const box = evidenceBox(t);
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
