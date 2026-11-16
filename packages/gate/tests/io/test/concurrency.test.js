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
import { JOB_WORKERS_ENV } from '../../../../drive/light.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

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

test('#5919 clause 1: a pulled job whose serve set its worker share spreads its files over that share, at least 1 [P7]', t => {
  assert.equal(executionCores({ [PULLED_JOB_ENV]: '1', [JOB_WORKERS_ENV]: '3' }), 3);
  assert.equal(executionCores({ [PULLED_JOB_ENV]: '1', [JOB_WORKERS_ENV]: '0' }), availableParallelism(), 'a share below 1 is no share');
  assert.equal(executionCores({ [JOB_WORKERS_ENV]: '3' }), performanceCores(), 'the share applies only inside a pulled job');
  assert.equal(testConcurrency(project(t), executionCores({ [PULLED_JOB_ENV]: '1', [JOB_WORKERS_ENV]: '3' })).files, 3);
  assert.equal(isolateTestMachine({ [JOB_WORKERS_ENV]: '3' }, project(t))[JOB_WORKERS_ENV], undefined, 'a test process never inherits the share');
});

test('#6753 clause 1: reading the settings twice spawns sysctl at most once per process [C7]', async t => {
  const root = project(t);
  const fresh = await import(`../../../src/io/test/concurrency.js?fresh=${process.pid}`);
  let spawns = 0;
  const spawn = () => { spawns += 1; return { status: 0, stdout: '4\n' }; };
  const first = fresh.performanceCores(spawn);
  const second = fresh.performanceCores(spawn);
  assert.equal(first, second);
  assert.equal(spawns, process.platform === 'darwin' ? 1 : 0);
  assert.equal(fresh.testConcurrency(root).files, first);
  assert.equal(spawns, process.platform === 'darwin' ? 1 : 0);
});
