/** Test file concurrency: every core inside a pulled runner job, the performance cores elsewhere, and a project's setting over both [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { executionCores } from '../../../src/io/test/concurrency.js';
import { performanceCores } from '../../../src/io/test/concurrency.js';
import { PULLED_JOB_ENV } from '../../../src/io/test/concurrency.js';
import { testConcurrency } from '../../../src/io/test/concurrency.js';
import { isolateTestMachine } from '../../../src/io/test/isolation.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureProjectPolicy } from '../../../../../apps/cli/tests/fixtures/testkit.js';

/** A project folder with an optional pullboard.json, removed after the test. */
function project(t, config) {
  const { root } = privateFixtureFiles('pullboard-concurrency-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (config) fixtureProjectPolicy(root, { config });
  return root;
}

test('#5790 clause 1: a run marked as a pulled runner job spreads its files over every core; an unmarked run keeps the performance cores [P7]', t => {
  assert.equal(executionCores({ [PULLED_JOB_ENV]: '1' }), availableParallelism());
  assert.equal(executionCores({}), performanceCores());
  const root = project(t);
  const previous = process.env[PULLED_JOB_ENV];
  t.after(() => { if (previous === undefined) delete process.env[PULLED_JOB_ENV]; else process.env[PULLED_JOB_ENV] = previous; });
  process.env[PULLED_JOB_ENV] = '1';
  assert.equal(testConcurrency(root).files, availableParallelism());
  delete process.env[PULLED_JOB_ENV];
  assert.equal(testConcurrency(root).files, performanceCores());
});

test('#5790 clause 1: a project\'s testConcurrency.files still decides inside a pulled runner job [P7]', t => {
  const root = project(t, { testConcurrency: { files: 3 } });
  assert.equal(testConcurrency(root, executionCores({ [PULLED_JOB_ENV]: '1' })).files, 3);
});

test('#5790 clause 1: a test process never inherits the pulled job marker, so a run a test starts keeps ordinary concurrency [P7]', t => {
  const sandbox = project(t);
  const env = isolateTestMachine({ [PULLED_JOB_ENV]: '1', KEEP: 'yes' }, sandbox);
  assert.equal(env[PULLED_JOB_ENV], undefined);
  assert.equal(env.KEEP, 'yes');
});
