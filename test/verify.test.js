/** Historical item authors cannot judge their own work after another seat takes over [V1,B3,C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Read a successful JSON CLI response; setup failures must not masquerade as eligibility failures. */
function document(result) {
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

/** A refusal leaves the submitted item and event stream untouched. */
function refused(box, board, cwd, args, expected) {
  const before = store.events(board);
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 1, result.err || result.out);
  assert.equal(JSON.parse(result.out).error.code, expected, result.out);
  assert.deepEqual(store.events(board), before);
  assert.equal(store.getItem(board, 1).item_review_by, null);
}

test('a reviewer is refused for any item its session ever built [V1,B3,C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const first = document(box.run(box.web, 'whoami', '--json')).id;
  // Bind an original seat without writing a claim digest. Native/legacy moves still name their agent in events.
  box.env.CODEX_THREAD_ID = 'historical-author-session-1085';
  document(box.run(box.web, 'shout', 'coordinator', 'the original author is here', '--json'));
  delete box.env.CODEX_THREAD_ID;
  const secondPath = join(box.dir, 'second-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', secondPath, 'main');
  const second = document(box.run(secondPath, 'join', 'web', '--json')).agent;
  const id = store.addItem(board, { by:'coordinator', lane:'web', title:'A handed-over item', criterion:'The page is ready.', check:'true', specs:'G1' });
  const freeze = () => ({ text:JSON.stringify({ rows:[] }), digest:'historical-author-1085' });
  const claim = agentId => store.claim(board, id, { agentId, lane:'web', leaseMs:3_600_000, freeze });
  claim(first);
  const oldHead = box.git(box.web, 'rev-parse', 'HEAD');
  submitFixture(board, id, { agentId:first, commit:oldHead, tree:box.git(box.web, 'rev-parse', 'HEAD^{tree}') });
  store.reopen(board, id, { agentId:'coordinator', note:'Another builder will continue this item.' });
  claim(second);
  const committed = helpers.commitFile(box, secondPath, 'web/ready.txt', 'ready\n', 'feat(web): finish the handed-over item [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const head = box.git(secondPath, 'rev-parse', 'HEAD');
  submitFixture(board, id, { agentId:second, commit:head, tree:box.git(secondPath, 'rev-parse', 'HEAD^{tree}') });
  assert.equal(store.getItem(board, id).item_built_by, second);
  assert.equal(existsSync(join(box.repo, '.git', 'pullboard', 'item-sessions.jsonl')), false,
    'the regression exercises historical event authors, not an already-protective session ledger entry');
  const before = store.events(board);
  const who = { agentId:first, lane:'web', leaseMs:3_600_000, policy:'any' };
  assert.throws(() => store.reserveReview(board, id, who), error => error.code === 'SELF_VERIFY');
  assert.equal(store.reserveNextReview(board, who).item, null, 'the old builder is not offered its former work');
  assert.throws(() => store.verify(board, id, { agentId:first, decision:'REJECT', reason:'TEST_FAILURE', note:'synthetic review attempt', head, digest:freeze().digest, policy:'any' }), error => error.code === 'SELF_VERIFY');
  assert.deepEqual(store.events(board), before, 'raw board refusals add no reservations or verdicts');
  const review = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, head);
  box.env.CODEX_THREAD_ID = 'historical-author-session-1085';
  document(box.run(review, 'join', 'web', '--json'));
  refused(box, board, review, ['next','--verify',String(id)], 'SELF_SESSION_VERIFY');
  refused(box, board, review, ['next','--verify'], 'NOTHING_FREE');
  refused(box, board, review, ['verify',String(id),'reject','--reason','TEST_FAILURE','--note','synthetic review attempt'], 'SELF_SESSION_VERIFY');
  box.env.CODEX_THREAD_ID = 'unrelated-reviewer-session-1085';
  document(box.run(review, 'takeover', '--json'));
  const offered = document(box.run(review, 'next', '--verify', String(id), '--json'));
  assert.equal(offered.item.item_id, id, 'an unrelated session is offered the submitted work');
  assert.notEqual(store.getItem(board, id).item_review_by, first);
});

/** Move only a private fixture's main during a real frozen check, then inspect the exact checked source. */
function movingReview(t, mode) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // Private check environments deliberately discard inherited author settings.
  box.git(box.repo, 'config', 'user.name', 'Review fixture');
  box.git(box.repo, 'config', 'user.email', 'review@example.invalid');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/feature.js'), 'original\n');
  box.git(box.repo, 'add', 'web/feature.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: initial feature [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const armed = join(box.dir, 'armed');
  const runs = join(box.dir, 'runs.json');
  const script = join(box.dir, 'check.cjs');
  writeFileSync(script, `const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const git = (...args) => cp.execFileSync('git', args, { cwd: ${JSON.stringify(box.repo)}, encoding: 'utf8' }).trim();
assert.equal(fs.readFileSync('web/feature.js', 'utf8'), 'built\\n');
if (fs.existsSync(${JSON.stringify(armed)})) {
  const path = ${JSON.stringify(runs)};
  const runs = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : [];
  runs.push({ head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), merged: fs.existsSync('docs/arrived.txt') });
  fs.writeFileSync(path, JSON.stringify(runs));
  if (runs.length === 1 || ${JSON.stringify(mode)} === 'twice') {
    const file = ${JSON.stringify(mode)} === 'conflict' ? 'web/feature.js' : 'docs/arrived.txt';
    fs.mkdirSync(${JSON.stringify(box.repo)} + '/docs', { recursive: true });
    fs.writeFileSync(${JSON.stringify(box.repo)} + '/' + file, 'main ' + runs.length + '\\n');
    git('add', file); git('commit', '-q', '-m', 'feat: move main during review [G1]');
  }
  if (runs.length === 2 && ${JSON.stringify(mode)} === 'once') assert.equal(fs.readFileSync('docs/arrived.txt', 'utf8'), 'main 1\\n');
}
`);
  document(box.run(box.repo, 'add', 'web', 'Review moving main', '--criterion', 'the feature builds', '--specs', 'G1', '--check', `node '${script}'`, '--json'));
  document(box.run(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  document(box.run(box.web, 'submit', '1', '--json'));
  const before = document(box.run(box.repo, 'show', '1', '--json'));
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, before.item_commit);
  document(box.run(reviewer, 'join', 'api', '--json'));
  writeFileSync(armed, 'armed');
  const result = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Observed the frozen check at each exact private source.', '--json');
  const after = document(box.run(box.repo, 'show', '1', '--json'));
  assert.equal(after.item_commit, before.item_commit, 'retry preserves the submitted head');
  assert.equal(after.item_frozen_digest, before.item_frozen_digest, 'retry preserves the frozen bar');
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), before.item_commit, 'retry never changes the live reviewer checkout');
  return { box, result, after, before, runs: JSON.parse(readFileSync(runs, 'utf8')) };
}

test('verify retries once at the clean new-main composition and binds its real source [V4,V8]', t => {
  const { box, result, after, before, runs } = movingReview(t, 'once');
  document(result);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].head, before.item_commit);
  assert.equal(runs[0].merged, false);
  assert.equal(runs[1].merged, true, 'the retry actually reads the new main file');
  const review = after.verdicts.at(-1).review;
  assert.equal(review.head, runs[1].head);
  assert.equal(review.trunk, box.git(box.repo, 'rev-parse', 'main'));
  assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', review.trunk, review.head), '');
  assert.equal(after.item_status, 'verified');
});

test('verify preserves a real main merge conflict without a retry or verdict [V4,V8]', t => {
  const { result, after, runs } = movingReview(t, 'conflict');
  assert.equal(JSON.parse(result.out).error.code, 'MERGE_CONFLICT');
  assert.equal(runs.length, 1);
  assert.equal(after.item_status, 'submitted');
  assert.deepEqual(after.verdicts, []);
});

test('verify refuses a second main move after its one retry [V4,V8]', t => {
  const { result, after, runs } = movingReview(t, 'twice');
  assert.equal(JSON.parse(result.out).error.code, 'VERDICT_TRUNK_MOVED');
  assert.equal(runs.length, 2, 'there is no third frozen check');
  assert.equal(after.item_status, 'submitted');
  assert.deepEqual(after.verdicts, []);
});
