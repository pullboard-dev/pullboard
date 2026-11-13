/** review.independence off lets a seat under the building session verify; the building seat is still refused (GitHub #27) [V1,B3]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";

/** Read a successful JSON CLI response. */
function document(result) {
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

test('review.independence off (the default): a seat under the building session verifies, the building seat does not [V1,B3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  box.env.CODEX_THREAD_ID = 'building-session-5407';
  document(await fixtureAdd(box.inProcess, box.repo, 'web', 'Built under one session', '--criterion', 'the feature builds', '--specs', 'G1', '--check', 'true', '--json'));
  document(await box.inProcess(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  document(await box.inProcess(box.web, 'submit', '1', '--json'));
  const own = await box.inProcess(box.web, 'verify', '1', 'accept', '--note', 'checked the feature', '--json');
  assert.equal(own.code, 1, own.out + own.err);
  assert.equal(JSON.parse(own.out).error.code, 'SELF_VERIFY', 'the building seat is still refused');
  const review = join(box.dir, 'review-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, box.git(box.web, 'rev-parse', 'HEAD'));
  document(await box.inProcess(review, 'join', 'api', '--model', FIXTURE_MODEL, '--route', 'strong', '--json'));
  const accepted = document(await box.inProcess(review, 'verify', '1', 'accept', '--note', 'checked the feature', '--json'));
  assert.ok(accepted, 'a different seat under the same session gives the verdict');
});
