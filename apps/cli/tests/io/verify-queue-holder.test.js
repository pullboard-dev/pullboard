/** While a queued accept's check runs, no second reviewer can take the item: next --verify and verify refuse and name the holder [C7,V4,#3161]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { fixtureProjectPolicy } from '../fixtures/testkit.js';
import { joinFixtureSeat } from '../fixtures/testkit.js';
import { stopFixtureLocalRunner } from '../fixtures/runner/local-stop.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** An item whose first reviewer has queued its accept check, plus a second review seat on a detached worktree. */
async function queued() {
  const box = e2e.privateCheckSubmission({ check: 'true' });
  const config = { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), verify: { policy: 'any', queueAccept: true } };
  fixtureProjectPolicy(box.repo, { config });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set verify.queueAccept');
  // The queued job is the proof here: the loopback runner is stopped, not merely unwaited, so the check cannot finish between the accept and the second reviewer's call.
  stopFixtureLocalRunner(join(box.dir, 'machine-home'));
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  const first = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--json');
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const holder = JSON.parse(first.stdout).reservedTo;
  const second = join(box.dir, 'second-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, box.commit);
  assert.equal((await joinFixtureSeat(box, second, 'api')).code, 0);
  return { box, holder, second };
}

test('cli.io-verify-queue-holder.next-verify-on-an-item-whose-queued: clause 1: next --verify on an item whose queued accept check is running does not hand it to a second reviewer [C7,V4]', async () => {
  const { box, holder, second } = await queued();
  const taken = await box.runLocal(second, 'next', '--verify', '1', '--json');
  assert.notEqual(taken.code, 0, 'a second reviewer is refused');
  assert.match(taken.stdout + taken.stderr, new RegExp(`REVIEW_HELD|REVIEW_RESERVED`, 'u'));
  assert.match(taken.stdout + taken.stderr, new RegExp(holder, 'u'), 'the refusal names the holder');
});

test('cli.io-verify-queue-holder.verify-on-an-item-whose-queued-accept: clause 1: verify on an item whose queued accept check is running refuses a second reviewer and names the holder [C7,V4]', async () => {
  const { box, holder, second } = await queued();
  for (const decision of [['accept', '--note', 'read the diff against the bar'], ['reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', 'the diff skips the bar clause']]) {
    const refused = await box.runLocal(second, 'verify', '1', ...decision, '--json');
    assert.notEqual(refused.code, 0, `${decision[0]} by a second reviewer is refused`);
    assert.match(refused.stdout + refused.stderr, new RegExp(holder, 'u'), `${decision[0]} names the holder`);
  }
  const shown = await box.runLocal(box.repo, 'show', '1', '--json');
  assert.doesNotMatch(shown.stdout, /"item_status":\s*"verified"/u, 'no verdict was recorded');
});
