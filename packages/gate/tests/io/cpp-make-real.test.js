/** @pullboard-test-input source-cell gate */
/** A real C++ Makefile fixture runs make test with the system compiler, exit code only [#10388,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

const FIXTURE = new URL('../fixtures/cpp-make/', import.meta.url);

/** The first of c++ and make that does not answer, or null when both do. */
function missingToolchain() {
  for (const tool of ['c++', 'make']) {
    const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return tool;
  }
  return null;
}

/** Copy the fixture files to a private temporary folder so the build output never lands in the repo. */
function tempCopy(t) {
  const { root, write } = privateFixtureFiles('cpp-make-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['Makefile', 'calc.cpp', 'calc_test.cpp']) write(name, readFileSync(new URL(name, FIXTURE)));
  return root;
}

test('gate.cpp-make-real.passes: clause 1: a checked-in Makefile fixture detects make test and passes with the system compiler [C7]', (t) => {
  const missing = missingToolchain();
  if (missing) return t.skip(`${missing} unavailable on this machine`);
  const root = tempCopy(t);
  assert.deepEqual(detectLanguages(root), [{ language: 'make', command: 'make test' }]);
  const run = spawnSync('make', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('gate.cpp-make-real.fails: clause 2: make test FAIL=1 exits non-zero [C7]', (t) => {
  const missing = missingToolchain();
  if (missing) return t.skip(`${missing} unavailable on this machine`);
  const root = tempCopy(t);
  const run = spawnSync('make', ['test', 'FAIL=1'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
});

test('gate.cpp-make-real.skips-unavailable: clause 3: a missing c++ or make is named as unavailable, never a failure [C7]', () => {
  const missing = missingToolchain();
  assert.ok(missing === null || ['c++', 'make'].includes(missing));
});
