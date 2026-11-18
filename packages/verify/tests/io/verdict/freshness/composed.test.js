/** A review stays bound to the composed submit: STALE_VERDICT fires on a composition commit as on a builder merge, and a stale re-review composes current main as an object [C7,U159]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeRef } from '../../../../../merge/index.js';
import { composeSubmissionMain } from '../../../../../merge/index.js';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';
import { composeReview } from '../../../../src/io/verdict/admission.js';
import { staleVerdictRefusal } from '../../../../src/io/verdict/freshness.js';
import { verdictProjector } from '../../../../src/io/verdict/freshness.js';

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Write a ten-line file with the given lines replaced, add it and commit it on the current branch; return the commit. */
function commitLines(dir, file, edits) {
  const lines = Array.from({ length: 10 }, (_, index) => `${file} line ${index}`);
  for (const [index, text] of Object.entries(edits)) lines[index] = text;
  writeFileSync(join(dir, file), `${lines.join('\n')}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `edit ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A repository where an item edits a.txt line 2 on its own branch while main first edits b.txt (`main1`).
 * `composition` is the submit composition of main1 and the head, parents main then head; `merge` is the builder's own
 * merge of main1 into the head, parents head then main. Both leave the checkout detached at the head with nothing dirty.
 */
function repo(t) {
  const dir = temporaryRepository(t, 'verdict-composed-');
  commitLines(dir, 'a.txt', {});
  commitLines(dir, 'b.txt', {});
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'item');
  const head = commitLines(dir, 'a.txt', { 2: 'item line two' });
  git(dir, 'checkout', '-q', 'main');
  const main1 = commitLines(dir, 'b.txt', { 5: 'main b five' });
  git(dir, 'checkout', '-q', '--detach', head);
  const composition = composeSubmissionMain(dir, main1, { item: 7 }).commit;
  git(dir, 'checkout', '-q', '-b', 'builder', head);
  git(dir, 'merge', '-q', '--no-ff', '-m', 'builder merge', main1);
  const merge = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '--detach', head);
  git(dir, 'branch', '-q', '-D', 'builder');
  /** Move main on with one edit and return its new tip, leaving the checkout where it was. */
  const moveMain = (file, edits) => {
    git(dir, 'checkout', '-q', 'main');
    const tip = commitLines(dir, file, edits);
    git(dir, 'checkout', '-q', '--detach', head);
    return tip;
  };
  /** The freshness state of an accepted item at `commit`, whose review sealed `trunk` and the touched path a.txt. */
  const stateAt = (commit, trunk, main) => verdictProjector(dir, {}, { main }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk, head: commit, paths: ['a.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' })
    .state({ item_id: 7, item_status: 'verified', item_commit: commit, item_claim_head: base });
  return { dir, base, head, main1, composition, merge, moveMain, stateAt };
}

test('verify.freshness.composed-stale: clause 1: an accept on a composition commit goes STALE_VERDICT when main changes the reviewed file and stays fresh when main touches none, as for a builder merge [C7,U159]', t => {
  const r = repo(t);
  assert.equal(git(r.dir, 'show', '-s', '--format=%P', r.composition), `${r.main1} ${r.head}`, 'the composition has parents main then head');
  const unrelated = r.moveMain('c.txt', { 1: 'main c one' });
  for (const [label, commit] of [['composition', r.composition], ['builder merge', r.merge]]) {
    assert.equal(r.stateAt(commit, r.main1, unrelated), null, `${label}: a main move touching no reviewed file keeps the verdict`);
  }
  const clash = r.moveMain('a.txt', { 2: 'main line two' });
  for (const [label, commit] of [['composition', r.composition], ['builder merge', r.merge]]) {
    const stale = r.stateAt(commit, r.main1, clash);
    assert.equal(stale?.code, 'STALE_VERDICT', `${label}: main changing the reviewed patch makes the verdict stale`);
    assert.equal(stale.file, 'a.txt', `${label}: the stale state names the changed file`);
    assert.equal(stale.commit, clash, `${label}: and the main commit that changed it`);
  }
});

test('verify.freshness.composed-re-review: clause 2: with the setting on, a stale re-review is offered on a fresh composition of current main and the head, and the text never asks for a main merge [C7,U159]', t => {
  const r = repo(t);
  // A main move on the same file that Git composes cleanly (line eight, the item edits line two), so the re-review can compose it.
  const moved = r.moveMain('a.txt', { 8: 'main line eight' });
  const stale = { code: 'STALE_VERDICT', file: 'a.txt', commit: moved };
  const item = { item_id: 7, item_status: 'verified', item_commit: r.composition, item_claim_head: r.base };
  git(r.dir, 'checkout', '-q', '--detach', r.composition);
  const composed = composeReview(r.dir, {}, item, r.composition, { reReview: true, head: r.composition, stale, events: () => [],
    refuseUnverifiedStack: () => {}, requireTrunkMerge: () => ({ commit: moved }), composeAsObject: true, composeMain: composeSubmissionMain });
  const ref = composeRef(7, moved);
  assert.equal(ref, `refs/pullboard/compose/7/${moved.slice(0, 12)}`);
  assert.equal(git(r.dir, 'rev-parse', ref), composed.commit, 'the fresh composition is kept under the compose ref');
  assert.equal(git(r.dir, 'show', '-s', '--format=%P', composed.commit), `${moved} ${r.composition}`, 'parents are current main then the head');
  assert.equal(composed.review.head, composed.commit, 'the sealed review is bound to the composition');
  assert.equal(composed.review.trunk, moved, 'against current main');
  assert.equal(git(r.dir, 'rev-parse', 'HEAD'), r.composition, 'the reviewed checkout did not move');
  const text = staleVerdictRefusal(item, stale, { composeAsObject: true });
  assert.equal(text.code, 'STALE_VERDICT');
  assert.match(text.message, /"a\.txt" changed on main in /u, 'the changed file and main commit are still named');
  assert.match(text.message, /re-reviews a fresh composition of current main and the submitted commit/u);
  assert.doesNotMatch(text.message, /merge current main|merge main/u, 'the builder is never asked to merge main');
});

test('verify.freshness.composed-off: clause 3: with the setting off the STALE_VERDICT text and the re-review path are unchanged [C7,U159]', t => {
  const r = repo(t);
  const clash = r.moveMain('a.txt', { 2: 'main line two' });
  const stale = { code: 'STALE_VERDICT', file: 'a.txt', commit: clash };
  const item = { item_id: 7, item_status: 'verified', item_commit: r.composition, item_claim_head: r.base };
  const expected = `item #7: "a.txt" changed on main in ${clash}; merge current main into the submitted commit, commit a clean composition, then another agent runs pullboard verify 7 accept --note "what was re-reviewed" before landing`;
  assert.equal(staleVerdictRefusal(item, stale).message.replace(/^\[STALE_VERDICT\] /u, ''), expected);
  assert.equal(staleVerdictRefusal(item, stale, { composeAsObject: false }).message, staleVerdictRefusal(item, stale).message, 'the default is off');
  git(r.dir, 'checkout', '-q', '--detach', r.composition);
  assert.throws(() => composeReview(r.dir, {}, item, r.composition, { reReview: true, head: r.composition, stale, events: () => [],
    refuseUnverifiedStack: () => {}, requireTrunkMerge: () => ({ commit: clash }), composeAsObject: false, composeMain: composeSubmissionMain }),
  error => error.code === 'STALE_VERDICT' && error.message.includes(expected), 'a stale re-review whose checkout lacks main is refused as before');
  assert.equal(git(r.dir, 'for-each-ref', `refs/pullboard/compose/7/${clash.slice(0, 12)}`), '', 'no composition is written');
});

test('verify.freshness.reprove-red-kept: clause 1: with landing.composedEquality on, an item reopened by a landing re-proof red keeps its accepted verdict when main changed no file its review covered [C7,U159]', t => {
  const r = repo(t);
  const unrelated = r.moveMain('c.txt', { 1: 'main c one' });
  const reopened = { item_id: 7, item_status: 'open', item_commit: r.composition, item_claim_head: r.base };
  const projector = main => verdictProjector(r.dir, {}, { main }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk: r.main1, head: r.composition, paths: ['a.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
  assert.deepEqual(projector(unrelated).reopened(reopened, { composedEquality: true }), { keep: true });
  assert.equal(projector(unrelated).state(reopened), null, 'a plain read of an open item still projects nothing');
});

test('verify.freshness.reprove-red-stale: clause 2: a reopened item loses its verdict as STALE_VERDICT when main at landing changed a file the review covered [C7,U159]', t => {
  const r = repo(t);
  const clash = r.moveMain('a.txt', { 2: 'main line two' });
  const reopened = { item_id: 7, item_status: 'open', item_commit: r.composition, item_claim_head: r.base };
  const result = verdictProjector(r.dir, {}, { main: clash }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk: r.main1, head: r.composition, paths: ['a.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' }).reopened(reopened, { composedEquality: true });
  assert.equal(result.keep, false);
  assert.equal(result.stale.code, 'STALE_VERDICT');
  assert.equal(result.stale.file, 'a.txt', 'the stale state names the changed file');
  assert.equal(result.stale.commit, clash, 'and the main commit that changed it');
});

test('verify.freshness.reprove-red-off: clause 3: with the setting off a reopened item verdict follows the rules of today and is not kept [C7,U159]', t => {
  const r = repo(t);
  const unrelated = r.moveMain('c.txt', { 1: 'main c one' });
  const reopened = { item_id: 7, item_status: 'open', item_commit: r.composition, item_claim_head: r.base };
  const projector = verdictProjector(r.dir, {}, { main: unrelated }, {
    events: () => [], acceptedVerdict: () => ({ review: { trunk: r.main1, head: r.composition, paths: ['a.txt'] } }),
    verdictReviewProblem: () => null, trunkRef: () => 'refs/heads/main' });
  assert.deepEqual(projector.reopened(reopened), { keep: false });
  assert.deepEqual(projector.reopened(reopened, { composedEquality: false }), { keep: false });
});
