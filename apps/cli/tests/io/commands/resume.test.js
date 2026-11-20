/** The coordinator's resume names a row the person approved that `spec apply` has not written yet, in text and in JSON [C7,I1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specBoxInProcess } from '../../fixtures/spec/box.js';

/** The spec source with one draft row and no approved row, the state a new board is in. */
const DRAFT_ONLY = `# Demo

## G · Goals
- G1 [draft, must] The person can name the project. | gate: review
`;

test('cli.io-commands-resume.text-names-approved-row-pending-apply: clause 1: after spec approve G1 with no apply, the text resume names G1 as approved and pending apply [C7,I1]', async (t) => {
  const box = await specBoxInProcess(t, { specSource: DRAFT_ONLY });
  const approved = await box.spec('approve', 'G1');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const resumed = await box.cmd('resume');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /^approved by the person, pending apply: G1$/mu);
  assert.match(resumed.stdout, /^next: pullboard spec apply, then commit SPEC\.md$/mu, 'the text next step agrees with the JSON one');
  assert.doesNotMatch(resumed.stdout, /next: the person approves rows/u);
});

test('cli.io-commands-resume.text-drops-row-after-apply: clause 2: after spec apply, the text resume no longer names G1 [C7,I1]', async (t) => {
  const box = await specBoxInProcess(t, { specSource: DRAFT_ONLY });
  assert.equal((await box.spec('approve', 'G1')).status, 0);
  assert.equal((await box.spec('apply')).status, 0);
  const resumed = await box.cmd('resume');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.doesNotMatch(resumed.stdout, /pending apply/u);
  assert.doesNotMatch(resumed.stdout, /\bG1\b/u);
});

test('cli.io-commands-resume.json-pending-apply-array: clause 3: pullboard resume --json prints a pendingApply array naming G1 [C7,I1]', async (t) => {
  const box = await specBoxInProcess(t, { specSource: DRAFT_ONLY });
  assert.equal((await box.spec('approve', 'G1')).status, 0);
  const resumed = await box.cmd('resume', '--json');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const card = JSON.parse(resumed.stdout);
  assert.deepEqual(card.pendingApply, ['G1']);
  assert.equal(card.next, 'pullboard spec apply, then commit SPEC.md');
});
