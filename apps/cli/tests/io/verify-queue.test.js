/** verify accept with verify.queueAccept on queues its frozen check as a runner job, reserves the review and returns at once [C7,V4,#3161]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { fixtureProjectPolicy } from '../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A submitted item with a private check and a review seat, the repo's main optionally carrying the setting. */
function submitted(queueAccept) {
  const box = e2e.privateCheckSubmission({ check: 'true' });
  if (queueAccept !== undefined) {
    const config = { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), verify: { policy: 'any', queueAccept } };
    fixtureProjectPolicy(box.repo, { config });
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: set verify.queueAccept');
  }
  // The queued job is the proof here; the loopback runner is not waited on.
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  return box;
}

test('clause 1: with verify.queueAccept on, verify accept returns within 2 s with the frozen check queued as a runner job and the review reserved to that seat [C7,V4]', async () => {
  const box = submitted(true);
  const started = performance.now();
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--json');
  const elapsed = performance.now() - started;
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.decision, 'QUEUED');
  assert.equal(result.queued, true);
  assert.match(result.checkJob, /^test:[0-9a-f]{12}:/u, 'the frozen check is a runner job');
  assert.ok(elapsed < 2000, `accept returned in ${Math.round(elapsed)} ms`); // budget: declared by the item's bar, 2 s for a queued accept.
  const shown = await box.runLocal(box.repo, 'show', '1', '--json');
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, new RegExp(result.reservedTo, 'u'), 'show names the seat holding the review');
  assert.doesNotMatch(shown.stdout, /"item_status":\s*"verified"/u, 'no verdict is recorded until the check finishes');
});

test('control: with the setting off, verify accept stays synchronous and records its verdict [C7,V4]', async () => {
  const box = submitted(undefined);
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).decision, 'ACCEPT');
});
