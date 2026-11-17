/** @pullboard-test-input source-cell gate */
/** A real CMake fixture configures, builds and runs ctest --output-junit, and junitCases reads the report [#10389,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitCases } from '../../src/logic/junit.js';
import { junitCommand } from '../../src/logic/junit-commands.js';
import { privateFixtureFiles } from '../fixtures/child.js';

const FIXTURE = new URL('../fixtures/cmake-proj/', import.meta.url);

/** The first of c++, cmake and ctest that does not answer, or null when all do. */
function missingToolchain() {
  for (const [tool, flag] of [['c++', '--version'], ['cmake', '--version'], ['ctest', '--version']]) {
    const probe = spawnSync(tool, [flag], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return tool;
  }
  return null;
}

/** Copy the fixture to a private temporary folder, so the build folder and the report never land in the repo. */
function tempCopy(t) {
  const { root, write } = privateFixtureFiles('cmake-proj-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['CMakeLists.txt', 'calc_test.cpp']) write(name, readFileSync(new URL(name, FIXTURE)));
  mkdirSync(join(root, '.pullboard', 'junit'), { recursive: true });
  return root;
}

test('gate.cmake-real.report-names-one-pass-one-fail: clause 1: the cmake row runs on a one-pass one-fail fixture and junitCases reads one pass and one fail from its report [C7]', (t) => {
  const missing = missingToolchain();
  if (missing) return t.skip(`${missing} unavailable on this machine`);
  const root = tempCopy(t);
  const row = junitCommand('cmake');
  // The failing add_test makes ctest exit non-zero, as a red gate does; the report is still written.
  spawnSync('sh', ['-c', row.command], { cwd: root, encoding: 'utf8' });
  const report = readFileSync(join(root, row.report), 'utf8');
  const { cases, reason } = junitCases(report);
  assert.equal(reason, null);
  assert.deepEqual(cases.map(({ name, outcome }) => [name, outcome]).sort(), [['calc_fails', 'fail'], ['calc_passes', 'pass']]);
});

test('gate.cmake-real.skips-unavailable: clause 2: a missing c++, cmake or ctest is named as unavailable, never a failure [C7]', () => {
  const missing = missingToolchain();
  assert.ok(missing === null || ['c++', 'cmake', 'ctest'].includes(missing));
});

test('gate.cmake-real.build-folder-stays-in-the-copy: clause 3: the build folder lives in the temporary copy, never in the repo [C7]', (t) => {
  const missing = missingToolchain();
  if (missing) return t.skip(`${missing} unavailable on this machine`);
  const root = tempCopy(t);
  spawnSync('sh', ['-c', junitCommand('cmake').command], { cwd: root, encoding: 'utf8' });
  assert.equal(existsSync(join(root, 'build')), true);
  assert.equal(existsSync(new URL('build', FIXTURE)), false);
});
