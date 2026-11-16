/** Prove the advisory dry-run review checklist: opt-in, printed once, recorded on the item, never a verdict [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const CRITERION = '1. the page renders [test] 2. the heading reads Page [reasoning]';

/** Open a project with one claimed web item whose bar has two numbered clauses and one commit to submit. */
async function claimedProject() {
  const box = e2e.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Dry run review', '--route', 'mid', '--criterion', CRITERION, '--check', 'true',
    '--brief', 'Files:\n- web/page.html\nTest:\n- the page renders');
  assert.equal(added.code, 0, added.err);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>\n', 'feat(web): add page [G1]').status, 0);
  return box;
}

/** How many dry-run notes the item's thread shows, read through the CLI. */
async function dryRunNotes(box) {
  const shown = await box.runLocal(box.repo, 'show', '1');
  assert.equal(shown.code, 0, shown.err);
  return (shown.out.match(/dry-run review ran/gu) ?? []).length;
}

test('[C7] clause 1: with bar.dryRunReview on, submit --dry-run-review prints the verifier checklist and records that it ran', async () => {
  const box = await claimedProject();
  const enabled = await box.runLocal(box.repo, 'settings', 'line', 'bar.dryRunReview', 'on', '--reason', 'builders read the checklist before review',
    '--window', '{"windowMinutes":60,"activeReviewers":2}');
  assert.equal(enabled.code, 0, enabled.err);
  const posted = await box.runLocal(box.web, 'fact', '1', 'bar-check', 'bar: both clauses hold\nedge cases: a repeated render\ntest: one case per clause');
  assert.equal(posted.code, 0, posted.err);

  const submitted = await box.runLocal(box.web, 'submit', '1', '--dry-run-review');
  assert.doesNotMatch(submitted.err, /dry-run/u, 'the checklist never refuses a submit');
  assert.match(submitted.out, /^dry-run review for #1: .*advisory, not a verdict, and no model is called$/mu);
  assert.match(submitted.out, /^ {2}1\. the page renders \[test\]$/mu, 'each bar clause is listed');
  assert.match(submitted.out, /^ {2}2\. the heading reads Page \[reasoning\]$/mu);
  assert.match(submitted.out, /^bar-check edge cases:\n {2}a repeated render$/mu, 'the builder note supplies the edge cases');
  assert.match(submitted.out, /^a test that fails without the fix:\n {2}clause 1 needs a test that fails on main/mu);
  assert.equal((submitted.out.match(/^dry-run review for #1/gmu) ?? []).length, 1, 'the checklist prints once');
  assert.equal(await dryRunNotes(box), 1, 'the item records that the dry run ran');
});

test('[C7] clause 2: bar.dryRunReview defaults to off and an off board prints and records nothing new', async () => {
  const box = await claimedProject();
  const settings = await box.runLocal(box.repo, 'settings', 'line');
  assert.equal(settings.code, 0, settings.err);
  assert.match(settings.out, /bar\.dryRunReview\W+off/u, 'the setting is off by default');

  const submitted = await box.runLocal(box.web, 'submit', '1', '--dry-run-review');
  assert.doesNotMatch(submitted.out, /dry-run review|bar-check edge cases|fails without the fix/u, 'the flag alone prints no checklist');
  assert.equal(await dryRunNotes(box), 0, 'nothing is recorded on the item');
});
