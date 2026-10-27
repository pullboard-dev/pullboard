/** @pullboard-test-loads src/next-review.js src/board.js */
/** Real Git and CLI coverage: a trunk conflict waits while another seat holds the head's review [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/**
 * A submitted web head that the trunk then conflicts with, plus two reviewer seats on the api lane.
 * The first reviewer reserves the head before the trunk moves, so the conflict arrives under a live review.
 */
function reservedConflictFixture() {
  const box = helpers.project('true');
  /** Demand real command success and its versioned result. */
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  const id = json(box.run(box.repo, 'add', 'web', 'Show the list', '--criterion', 'web/list.html exists', '--json')).item.item_id;
  json(box.run(box.web, 'claim', String(id), '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/list.html'), '<ul>from the branch</ul>\n');
  box.git(box.web, 'add', 'web/list.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): show the list [G1]');
  json(box.run(box.web, 'submit', String(id), '--json'));
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', reviewer, '-b', 'api/review-one');
  json(box.run(reviewer, 'join', 'api', '--json'));
  const other = join(box.dir, 'api-2');
  box.git(box.repo, 'worktree', 'add', '-q', other, '-b', 'api/review-two');
  json(box.run(other, 'join', 'api', '--json'));
  return { box, json, id, reviewer, other };
}

/**
 * The refusal code of a `next --verify` that found nothing to review, or null. Taking nothing is a
 * correct answer when the only submitted head is held or was just returned.
 */
function nothingFree(result) {
  if (result.code === 0) return null;
  return JSON.parse(result.out).error.code;
}

/** The trunk moves: main lands its own version of the same file, so the submitted head no longer merges. */
function moveTrunk(box) {
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/list.html'), '<ol>from main</ol>\n');
  box.git(box.repo, 'add', 'web/list.html');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(web): main lands its own list [G1]');
}

test('a trunk conflict waits while another seat reserves the head, then applies when the reservation ends [C7,V4]', () => {
  const { box, json, id, reviewer, other } = reservedConflictFixture();
  const reserved = json(box.run(reviewer, 'next', '--verify', '--json'));
  assert.equal(reserved.item.item_id, id, 'the first reviewer reserves the head before the trunk moves');
  const holder = json(box.run(box.repo, 'show', String(id), '--json')).item_review_by;
  assert.ok(holder, 'the reservation names its reviewer');

  moveTrunk(box);

  const held = box.run(other, 'next', '--verify', '--json');
  assert.equal(nothingFree(held), 'NOTHING_FREE', 'the second reviewer has nothing to take, since the head is held');
  assert.doesNotMatch(held.err, /returned #/u, 'a second reviewer does not return a head another seat holds');
  const stillSubmitted = json(box.run(box.repo, 'show', String(id), '--json'));
  assert.equal(stillSubmitted.item_status, 'submitted', 'the head stays submitted while the reservation is live');
  assert.equal(stillSubmitted.item_review_by, holder, 'the reservation is untouched');
  assert.ok(!stillSubmitted.thread.some((entry) => entry.type === 'move' && entry.kind === 'reopen'), 'no reopen is recorded');

  const notice = box.run(reviewer, 'inbox').out;
  assert.match(notice, new RegExp(`#${id} conflicts with the trunk at [0-9a-f]{12} in web/list\\.html; your review holds it until`, 'u'),
    'the reviewer holding the reservation is told the named file conflicts');

  json(box.run(reviewer, 'release', String(id), '--note', 'stepping away', '--json'));
  const applied = box.run(other, 'next', '--verify', '--json');
  assert.match(applied.err, new RegExp(`returned #${id} to its builder unreviewed: it no longer merges onto the trunk \\(web/list\\.html\\)`, 'u'),
    'once the reservation ends the conflict return applies');
  const returned = json(box.run(box.repo, 'show', String(id), '--json'));
  assert.equal(returned.item_status, 'open', 'the head goes back to its builder');
  assert.equal(returned.item_review_by, null, 'no reviewer holds it');
});
