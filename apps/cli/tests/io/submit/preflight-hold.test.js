/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin: clause 2 reads the submit command source to prove the preflight dry-run's write transaction runs no Git read, the 4-6 s board-write hold the hold log named at preflight.js:129 [C7,#11710]. */
/** The submit command reads the item's changed files from Git before the preflight dry-run opens its write transaction, and the dry-run's callbacks read none [C7,#11710]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SUBMIT = readFileSync(fileURLToPath(new URL('../../../src/io/commands/submit.js', import.meta.url)), 'utf8');
/** The preflight-record step: the submitPreflight call and its refuse callback, which run inside the rolled-back write transaction. */
const STEP_AT = SUBMIT.indexOf("authorizationStep('preflight-record'");
const STEP = SUBMIT.slice(STEP_AT, SUBMIT.indexOf('\n', SUBMIT.indexOf('refuseUnreviewable(', STEP_AT)));

test('cli.io-submit-preflight-hold.git-files-read-before-the-write-lock: clause 2: the changed files are read from Git in their own step before the preflight-record step opens the write transaction [C7,#11710]', () => {
  assert.ok(STEP_AT > 0, 'the preflight-record step is in the submit command');
  const before = SUBMIT.indexOf('filesSince(root, id, claimHead, commit)');
  assert.ok(before > 0 && before < STEP_AT, 'filesSince runs before the preflight-record step');
  assert.match(SUBMIT.slice(before - 80, before), /authorizationStep\('preflight-files'/u, 'the Git read is its own recorded step');
});

test('cli.io-submit-preflight-hold.dry-run-callbacks-run-no-git: clause 1: the preflight dry-run passes the already-read files and calls no Git reader inside its write transaction [C7,#11710]', () => {
  assert.ok(STEP.length > 100, 'the preflight-record step was found');
  assert.match(STEP, /machineVerificationEligible\(observed, item, preflightFiles\)/u, 'the eligibility check receives the files read earlier');
  assert.doesNotMatch(STEP, /\b(filesSince|changedLines|changedSince|tryGit|git)\s*\(/u, 'no Git reader runs inside the preflight write transaction');
});
