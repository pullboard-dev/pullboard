/** A unique repair owner shows in the pulled submit's proof and test JSON [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { fileMainRed } from '../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../tests/fixtures/affected.js';

const FILE = 'test/affected.test.js';
const NAME = 'affected case [G1]';

/** Exact wording, case identity and receipt are shared by both command documents. */
function notice(value, box, { owner, only = false } = {}) {
  assert.equal(value.file, FILE);
  assert.equal(value.name, NAME);
  assert.equal(value.main, box.main);
  const expected = only ? `fails only with your change: ${FILE} :: ${NAME}`
    : `also fails on main at ${box.main}: ${FILE} :: ${NAME} (not yours; ${owner ? `owner #${owner}` : 'accepted'})`;
  // The pulled path names the main test job that judged the case, not a receipt id [P7,C7].
  assert.ok(value.message.startsWith(expected), value.message);
  assert.match(value.message, /test job test:[a-f0-9]+:[a-f0-9]+\)$/u);
  assert.equal(value.status, only ? 'candidate-only' : 'also-main');
}

test('a unique repair owner appears in the pulled submit proof and in test JSON [V4,B3,C7]', async t => {
  const box = fixture(t);
  const owner = fileMainRed(box);
  // Submit runs first: the JSON test run below files its own Main red for the case, after which the file has two owners.
  const report = await settledSubmit(t, box);
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => [row.file, row.name, row.item]), [[FILE, NAME, owner]]);
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  assert.equal(JSON.parse(tested.stdout).mainFailures.length, 1, tested.stdout);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { owner });
});
