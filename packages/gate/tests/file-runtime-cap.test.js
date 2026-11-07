/** The two-minute file cap refuses a candidate that pushes a file past it, naming the file and a split seam [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILE_RUNTIME_CAP_MS } from '../src/core/file-runtime-cap.js';
import { fileRuntimeCapFailure } from '../src/core/file-runtime-cap.js';
import { fileRuntimeCapOutput } from '../src/core/file-runtime-cap.js';
import { fileRuntimeCapReport } from '../src/core/file-runtime-cap.js';
import { splitSeam } from '../src/core/file-runtime-cap.js';

const tests = [{ name: 'a', durationMs: 50_000 }, { name: 'b', durationMs: 60_000 }, { name: 'c', durationMs: 70_000 }];

test('clause 1: a candidate that pushes a file past two minutes is refused naming the file and a split seam', () => {
  const report = fileRuntimeCapReport({ 'test/x.test.js': { durationMs: 180_000, tests } }, { 'test/x.test.js': 60_000 });
  assert.equal(FILE_RUNTIME_CAP_MS, 120_000);
  assert.equal(report.ok, false);
  assert.match(report.refusals[0].message, /^test\/x\.test\.js now takes 180s \(was 60s, \+120s\)/);
  assert.match(report.refusals[0].message, /split seam: cut after test 2 of 3 \("b"\)/);
  assert.match(fileRuntimeCapOutput(report), /^file runtime cap: test\/x\.test\.js/);
});

test('clause 1: a file already over two minutes is listed for a split item, not refused, unless it grows past the cap again', () => {
  const before = { 'test/slow.test.js': 300_000, 'test/fast.test.js': 5_000 };
  const same = fileRuntimeCapReport({ 'test/slow.test.js': 310_000 }, before);
  assert.equal(same.ok, true);
  assert.deepEqual(same.over, [{ file: 'test/slow.test.js', durationMs: 300_000 }]);
  assert.match(fileRuntimeCapOutput(same), /files over 120s today[^]*test\/slow\.test\.js: 300s/);
  assert.match(fileRuntimeCapFailure('test/slow.test.js', 430_000, 300_000), /\+130s/);
  assert.equal(fileRuntimeCapFailure('test/fast.test.js', 119_000, 5_000), null);
  assert.equal(fileRuntimeCapFailure('test/new.test.js', 500_000, undefined), null);
});

test('clause 1: the split seam falls back to a generic cut without per-test times and rejects bad input', () => {
  assert.match(splitSeam([]), /top-level describe\/test groups/);
  assert.match(splitSeam(tests), /60s in the first file|110s in the first file/);
  assert.throws(() => fileRuntimeCapFailure('f', Number.NaN, 0), /missing test file runtime/);
  assert.throws(() => fileRuntimeCapFailure('f', 1, 0, [], 0), /positive finite/);
});
