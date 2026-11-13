/** A claimed item keeps its frozen lane policy until refreeze, in submit and patch alike [V2,L3]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { policyFixtures } from '../../tests/fixtures/lanes-policy.js';
import { assertWaitsOnOwner } from '../../tests/fixtures/lanes-policy.js';
import { reassignedPathFixture } from '../../tests/fixtures/lanes-policy.js';

after(policyFixtures.cleanup);

test('refreeze picks up a lane change made after the claim [V2,L3]', async () => {
  const { box, before, trunkPolicy } = await reassignedPathFixture();
  await assertWaitsOnOwner(box, 1, await box.runLocal(box.web, 'submit', '1', '--json'), 'api', ['api/shared.js'],
    'a landed lane change does not silently widen the frozen claim');
  const refreshed = await box.runLocal(box.repo, 'refreeze', '1');
  assert.equal(refreshed.code, 0, refreshed.err);
  const refrozen = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  const originalFreeze = JSON.parse(before.item_frozen);
  const currentFreeze = JSON.parse(refrozen.item_frozen);
  assert.equal(currentFreeze.policy, undefined, 'the refreeze holds the bar alone, no policy pin [B4]');
  assert.deepEqual(currentFreeze, originalFreeze,
    'a lane-only policy change keeps the criterion, title, check and cited rows unchanged');
  assert.equal(refrozen.item_status, 'open');
  const lifted = await box.runLocal(box.repo, 'hold', '1', '--off');
  assert.equal(lifted.code, 0, lifted.err + lifted.out);
  const reclaimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const item = JSON.parse((await box.runLocal(box.web, 'show', '1', '--json')).out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_frozen_digest, refrozen.item_frozen_digest, 'reclaim and submission keep the bar digest');
});

test('a claimed item keeps its policy until refreeze [V2,L3]', async () => {
  const { box, before, trunkPolicy } = await reassignedPathFixture();
  const renewed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(renewed.code, 0, renewed.err);
  await assertWaitsOnOwner(box, 1, await box.runLocal(box.web, 'submit', '1', '--json'), 'api', ['api/shared.js'],
    'submission still enforces the old ownership until an explicit coordinator refreeze');
  const lifted = await box.runLocal(box.repo, 'hold', '1', '--off');
  assert.equal(lifted.code, 0, lifted.err + lifted.out);
  // A changed lane policy is not a bar change: the re-claim succeeds and keeps the bar bytes [B4].
  const reclaim = await box.runLocal(box.web, 'claim', '1');
  assert.equal(reclaim.code, 0, reclaim.err + reclaim.out);
  assert.doesNotMatch(reclaim.err + reclaim.out, /NO_POLICY/u);
  const reclaimed = JSON.parse((await box.runLocal(box.web, 'show', '1', '--json')).out);
  assert.equal(reclaimed.item_frozen, before.item_frozen, 'the re-claim keeps the criterion bytes');
  assert.equal(reclaimed.item_frozen_digest, before.item_frozen_digest);
  assert.equal(JSON.parse(reclaimed.item_frozen).policy, undefined);
  assert.notEqual(trunkPolicy, before.item_claim_head);
});

test('submit and patch attach share frozen ownership and move together on refreeze [L2,L3,V2,V4]', async () => {
  const { box, before, trunkPolicy } = await reassignedPathFixture();
  const previous = before.item_claim_head;
  const author = JSON.parse((await box.runLocal(box.web, 'whoami', '--json')).out).id;
  const patchFile = join(box.dir, 'ownership.patch');
  writeFileSync(patchFile, [
    'diff --git a/api/shared.js b/api/shared.js',
    '--- a/api/shared.js',
    '+++ b/api/shared.js',
    '@@ -1 +1 @@',
    '-changed',
    '+patched',
    '',
  ].join('\n'));
  await assertWaitsOnOwner(box, 1, await box.runLocal(box.web, 'submit', '1', '--json'), 'api', ['api/shared.js']);
  const deniedAttach = await box.runLocal(box.repo, 'patch', 'attach', '1', patchFile,
    '--key', 'ownership', '--author', author, '--json');
  assert.equal(deniedAttach.code, 1, deniedAttach.err + deniedAttach.out);
  const error = JSON.parse(deniedAttach.out).error;
  assert.equal(error.code, 'OUTSIDE_LANE');
  assert.ok(error.message.includes(previous), 'the refusal names the frozen ownership commit');
  assert.ok(error.message.includes("api/shared.js (api's)"), 'the old policy owns the exact path');
  const unchanged = JSON.parse((await box.runLocal(box.repo, 'patch', 'list', '1', '--json')).out);
  assert.deepEqual(unchanged.patches, [], 'rejected ownership writes no companion');
  const refrozen = await box.runLocal(box.repo, 'refreeze', '1', '--json');
  assert.equal(refrozen.code, 0, refrozen.err + refrozen.out);
  const lifted = await box.runLocal(box.repo, 'hold', '1', '--off');
  assert.equal(lifted.code, 0, lifted.err + lifted.out);
  const reclaimed = await box.runLocal(box.web, 'claim', '1', '--json');
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const item = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(JSON.parse(item.item_frozen).policy, undefined, 'the bar carries no policy pin [B4]');
  const attached = await box.runLocal(box.repo, 'patch', 'attach', '1', patchFile,
    '--key', 'ownership', '--author', author, '--json');
  assert.equal(attached.code, 0, attached.err + attached.out);
  assert.equal(JSON.parse(attached.out).changed, true, 'the same author now owns this path under the refrozen policy');
});
