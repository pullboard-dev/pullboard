/** @pullboard-test-input source-tree */
/** A file the gate's watchdog stopped is recorded, never bisected or charged, and alone it never blocks a landing [C7,#3167]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingFailures } from '../packages/landing/src/shell/landing-step-failures.js';
import { unwaivedFailures } from '../packages/landing/src/shell/landing-step-failures.js';
import { watchdogProof } from '../packages/landing/src/shell/landing-step-failures.js';

const JOB = '/Users/someone/.pullboard-runner/jobs/8f32e665-yDzw7j/checkout';

/** Runner output: one file past its wall, one file aborted by the stop, and one ordinary named red. */
const OUTPUT = `TAP version 13
# run-tests: TIMEOUT file "${JOB}/test/machine.test.js" slowest running case "x (running 299891ms)": whole-file wall limit 300000ms
not ok 1 - ${JOB}/apps/cli/tests/worktree-maintenance-scheduler.test.js
  ---
  error: 'This operation was aborted'
  code: 20
  name: 'AbortError'
  ...
not ok 2 - ${JOB}/test/machine.test.js
  ---
  error: 'test timed out after 300000ms'
  ...
# Subtest: a real case
not ok 3 - a real case
  ---
  error: 1 !== 0
  location: ${JOB}/test/real.test.js:5
  ...
`;

/** Ports with an empty quarantine, so no waiver covers anything. */
const state = { board: { db: { prepare: () => ({ all: () => [] }) }, clock: { now: () => new Date() } }, landingPorts: { quarantineWaivers: () => [] } };

test('a watchdog-stopped or aborted file is flagged by its repo path; a named red is not [C7,#3167]', () => {
  const failures = landingFailures(OUTPUT, '/elsewhere');
  assert.deepEqual(failures.map(row => [row.file, row.watchdog === true]), [
    ['apps/cli/tests/worktree-maintenance-scheduler.test.js', true],
    ['test/machine.test.js', true],
    ['test/real.test.js', false],
  ]);
  assert.deepEqual(unwaivedFailures(state.board, failures, state.landingPorts).map(row => row.file), ['test/real.test.js']);
});

test('red only in stopped files is a landing proof; one named red voids it [C7,#3167]', () => {
  const failures = landingFailures(OUTPUT, '/elsewhere');
  const proof = watchdogProof(state, { failures: failures.slice(0, 2), tree: 'tree', logPath: 'log' });
  assert.deepEqual(proof, { tree: 'tree', failures: [], knownMain: [], logPath: 'log',
    watchdogStopped: failures.slice(0, 2).map(({ file, name }) => ({ file, name })) });
  assert.equal(watchdogProof(state, { failures, tree: 'tree', logPath: 'log' }), null);
  assert.equal(watchdogProof(state, { failures: [], tree: 'tree', logPath: 'log' }), null);
  assert.equal(watchdogProof(state, { failures: failures.slice(0, 2), tree: 'tree', requiresGreen: true }), null);
});
