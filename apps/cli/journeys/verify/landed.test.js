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
  const merged = await box.runLocal(box.repo, 'merged', String(id), landing, '--forced', 'hand landed around the gate');
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
