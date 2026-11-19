/** A job that exited non-zero still lends its authenticated completion to a green whose own file process exited 0, and to nothing else [C7,#11103]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { reusableResult } from '../../../src/io/test/action/cache.js';
import { completedTestResult } from '../../../src/io/test/store.js';
import { importTestResults } from '../../../src/io/test/store.js';
import { packTestResults } from '../../../src/io/test/store.js';
import { storeTestResult } from '../../../src/io/test/store.js';
import { testResultDigest } from '../../../src/io/test/store.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const COMMIT = 'a'.repeat(40);
const AT = '2026-11-19T01:00:00.000Z';
const CONTEXT = { node: process.version, platform: process.platform, arch: process.arch, environment: [] };

/** A job receipt that exited 1 with no signal, authenticated for the request and commit. */
function failedJob() {
  return { id: REQUEST, commit: COMMIT, tree: 'b'.repeat(40), code: 1, signal: null,
    outputSha256: 'c'.repeat(64), runtimeSha256: 'd'.repeat(64), toolingSha256: 'e'.repeat(64) };
}

/** One result row for a file; a green carries complete TAP, and fileExit marks the file's own exit 0. */
function row(letter, status, fileExit) {
  const inputKey = letter.repeat(64);
  const origin = { machine: 'machine-a', stage: 'test', commit: COMMIT, at: AT, request: REQUEST, ...(fileExit === undefined ? {} : { fileExit }) };
  const base = { version: 2, inputKey, key: testResultDigest({ inputKey, context: CONTEXT }), context: CONTEXT, file: `test/${letter}.test.js`, commit: COMMIT, stage: 'test', at: AT, status, origin };
  return status === 'fail' ? base : { ...base, tap: { lines: ['ok 1 - case'], counts: { passed: 1, failed: 0, skipped: 0, tests: 1 }, observedTests: 1 } };
}

/** An empty result store that goes away with the test. */
function emptyStore(t) {
  const { root } = privateFixtureFiles('pullboard-test-store-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root + '/.store';
}

test('gate.io-test-store.green-keeps-completion-on-red-job: clause 1: a green row with origin.fileExit 0 keeps the completion of a job that exited 1 and is reusable, beside a red row [C7,#11103]', t => {
  const store = emptyStore(t);
  const green = row('1', 'pass', 0), red = row('2', 'fail');
  const packet = packTestResults([green, red]);
  assert.equal(importTestResults(store, packet, [green.inputKey, red.inputKey], failedJob()), 2);
  const stored = reusableResult(store, green.key);
  assert.equal(stored?.status, 'pass', 'the green is reusable');
  assert.equal(stored.origin.completion.code, 1, 'it carries the completion of the job that exited 1');
  assert.ok(completedTestResult(stored), 'the completion counts as completed proof');
  assert.equal(reusableResult(store, red.key), null, 'the red row is never reusable');
});

test('gate.io-test-store.green-without-file-exit-gets-no-completion: clause 2: a green row without origin.fileExit gets no completion under a code-1 receipt, and a red tombstone is not replaced by a later green [C7,#11103]', t => {
  const store = emptyStore(t);
  const unmarked = row('3', 'pass'), red = row('4', 'fail');
  assert.equal(importTestResults(store, packTestResults([unmarked, red]), [unmarked.inputKey, red.inputKey], failedJob()), 2);
  assert.equal(reusableResult(store, unmarked.key)?.origin.completion, undefined, 'no completion without the file exit mark');
  assert.ok(!completedTestResult({ ...unmarked, origin: { ...unmarked.origin, completion: failedJob() } }), 'a code-1 completion proves an unmarked green nothing');
  const later = row('4', 'pass', 0);
  assert.equal(storeTestResult(store, later), false, 'a later green for a red key is refused');
  assert.equal(reusableResult(store, red.key), null, 'the tombstone stays');
  const signalled = { ...failedJob(), signal: 'SIGKILL' };
  assert.ok(!completedTestResult({ ...row('5', 'pass', 0), origin: { ...row('5', 'pass', 0).origin, completion: signalled } }), 'a signal still voids the completion');
});
