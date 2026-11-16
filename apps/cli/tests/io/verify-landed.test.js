/** verify records a verdict on an item the smoke lander already landed; a reject opens a follow-up for the builder [V1,H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { fileFixtureItem } from '../fixtures/testkit.js';

/** A landed item: filed, then recorded as merged by hand the way the smoke lander lands it. */
async function landed(box, title) {
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title });
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const merged = await box.runLocal(box.repo, 'merged', String(item.item_id), commit, '--forced', 'smoke lander landed it before review', '--waive-proof', 'fixture', '--json');
  assert.equal(merged.code, 0, merged.out + merged.err);
  return item.item_id;
}

test('clause 1: verify accept and reject on a landed item records the verdict, and a reject reopens a follow-up for the builder instead of refusing as terminal [V1,H16]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const kept = await landed(box, 'Landed then accepted');
  const accepted = await box.runLocal(box.web, 'verify', String(kept), 'accept', '--note', 'read the diff against the bar and ran its check', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
  const bad = await landed(box, 'Landed then rejected');
  const rejected = await box.runLocal(box.web, 'verify', String(bad), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', 'the landed code skips the bar clause', '--json');
  assert.equal(rejected.code, 0, rejected.out + rejected.err);
  const verdict = JSON.parse(rejected.out);
  assert.equal(verdict.decision, 'REJECT');
  assert.ok(verdict.followUp > bad, 'a reject opens a follow-up item');
  const shown = await box.runLocal(box.repo, 'show', String(verdict.followUp), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.match(shown.out, new RegExp(`#${bad}`, 'u'), 'the follow-up names the landed item it came from');
});
