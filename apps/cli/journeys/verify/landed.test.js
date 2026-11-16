/** A reject on an item a forced merge landed returns the work to its builder with the cause, and the landing stays [V1,H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

test('clause 1: a reject on a forced-landed item returns it to its builder as a follow-up item and show prints the cause [V1,H16,C7]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Landed then rejected' });
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const merged = await box.runLocal(box.repo, 'merged', String(item.item_id), commit, '--forced', 'smoke lander landed it before review', '--waive-proof', 'fixture', '--json');
  assert.equal(merged.code, 0, merged.out + merged.err);
  const rejected = await box.runLocal(box.web, 'verify', String(item.item_id), 'reject', '--reason', 'TEST_FAILURE', '--clause', '1', '--note', 'from another family: the landed code skips the bar clause', '--json');
  assert.equal(rejected.code, 0, rejected.out + rejected.err);
  const verdict = JSON.parse(rejected.out);
  assert.equal(verdict.decision, 'REJECT');
  const followUp = await box.runLocal(box.repo, 'show', String(verdict.followUp));
  assert.match(followUp.out, /Landed #\d+ at [0-9a-f]{40} was rejected after landing \(TEST_FAILURE\)/u, 'the follow-up carries the cause');
  const shown = await box.runLocal(box.repo, 'show', String(item.item_id));
  assert.match(shown.out, /TEST_FAILURE/u, 'show on the landed item prints the cause');
  assert.match(shown.out, /landed|merged/iu, 'the landing stays');
});
