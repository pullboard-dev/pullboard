/** A seat of another family judges work a forced merge landed around the gate; the landing stays [V1,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

/** Require an actual successful JSON command. */
async function json(box, root, ...args) {
  const result = await box.runLocal(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** An unbuilt item the coordinator landed by hand with a forced merge, and a reviewer seat of another family. */
async function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/result.txt'), 'hand landed\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(web): land the result by hand [G1]');
  const landing = box.git(box.repo, 'rev-parse', 'HEAD');
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Hand landed result', criterion: 'the result exists', check: 'test -f web/result.txt', run: box.runLocal });
  const id = item.item_id;
  const merged = await box.runLocal(box.repo, 'merged', String(id), landing, '--forced', 'hand landed around the gate', '--waive-proof', 'fixture has no receipt');
  assert.equal(merged.code, 0, merged.out + merged.err);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, landing);
  assert.equal((await joinFixtureSeat(box, reviewer, 'api', { model: FIXTURE_MODEL, run: box.runLocal })).code, 0);
  return { box, id, landing, reviewer };
}

test('another family accepts a forced-landed item and the landing is kept [V1,H16]', async t => {
  const { box, id, landing, reviewer } = await fixture(t);
  const accepted = await box.runLocal(reviewer, 'verify', String(id), 'accept', '--note', 'Read the hand landing and ran its frozen check; the file exists.');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  const item = await json(box, box.repo, 'show', String(id));
  assert.equal(item.item_merged_commit, landing, 'the landing is kept');
  assert.equal(item.item_status, 'withdrawn', 'the status is kept');
  assert.equal(item.item_verdict, 'ACCEPT');
  assert.ok(item.item_verified_by);
  const shown = await box.runLocal(box.repo, 'show', String(id));
  assert.match(shown.out, /ACCEPT/u, 'show prints the accept verdict');
});

/** The same forced-landed fixture, but the item was claimed by the web seat before the coordinator merged it, so that seat is its builder. */
async function builtFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Built then hand landed', criterion: 'the result exists', check: 'test -f web/result.txt', run: box.runLocal });
  const id = item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  // The web seat commits the work, so the board knows it as the author; the coordinator then fast-forwards main onto it and lands it by hand.
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/result.txt'), 'hand landed\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): land the result by hand [G1]');
  const landing = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'merge', '-q', '--ff-only', landing);
  const merged = await box.runLocal(box.repo, 'merged', String(id), landing, '--forced', 'hand landed around the gate');
  assert.equal(merged.code, 0, merged.out + merged.err);
  return { box, id };
}

test('clause 1: the builder seat is refused when it runs verify on its forced-landed item [V1,H16]', async t => {
  const { box, id } = await builtFixture(t);
  const refused = await box.runLocal(box.web, 'verify', String(id), 'accept', '--note', 'Read my own landing; it looks right.');
  assert.notEqual(refused.code, 0, 'the builder never verifies its own work');
  const item = await json(box, box.repo, 'show', String(id));
  assert.equal(item.item_verdict ?? null, null, 'no verdict was recorded');
});

test('clause 2: an item that already has a verdict refuses a second one [V1,H16]', async t => {
  const { box, id, reviewer } = await fixture(t);
  const note = 'Read the hand landing and ran its frozen check; the file exists.';
  assert.equal((await box.runLocal(reviewer, 'verify', String(id), 'accept', '--note', note)).code, 0);
  const second = await box.runLocal(reviewer, 'verify', String(id), 'accept', '--note', note);
  assert.notEqual(second.code, 0, second.out + second.err);
  assert.match(second.out + second.err, /NOT_LANDED[^]*already has a ACCEPT verdict/u);
});
