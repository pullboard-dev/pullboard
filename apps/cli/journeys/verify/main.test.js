/** Historical item authors cannot judge their own work after another seat takes over [V1,B3,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { requireSessionIndependence } from "../../tests/fixtures/testkit.js";
import { joinFixtureSeat } from "../../tests/fixtures/testkit.js";
import { submitFixture } from "../../tests/fixtures/board/submit.js";
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

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

test('clause 1, clause 2: a reviewer is refused for any item its session ever built [V1,B3,C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // @pullboard-board-file journey: share the board file the real verify command reads
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => store.closeBoard(board));
  const first = document(box.run(box.web, 'whoami', '--json')).id;
  // Bind an original seat without writing a claim digest. Native/legacy moves still name their agent in events.
  box.env.CODEX_THREAD_ID = 'historical-author-session-1085';
  document(box.run(box.web, 'shout', 'all', 'the original author is here', '--json'));
  delete box.env.CODEX_THREAD_ID;
  const secondPath = join(box.dir, 'second-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', secondPath, 'main');
  const second = document(joinFixtureSeat(box, secondPath, 'web')).agent;
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
  document(joinFixtureSeat(box, review, 'web'));
  requireSessionIndependence(review);
  refused(box, board, review, ['next','--verify',String(id)], 'SELF_SESSION_VERIFY');
  // A next --verify with nothing free records its idle cause once, then dedupes the same cause: record it here so the refusal below leaves the stream untouched.
  assert.equal(JSON.parse(box.run(review, 'next', '--verify', '--json').out).error.code, 'NOTHING_FREE');
  refused(box, board, review, ['next','--verify'], 'NOTHING_FREE');
  refused(box, board, review, ['verify',String(id),'reject','--reason','TEST_FAILURE','--note','synthetic review attempt'], 'SELF_SESSION_VERIFY');
  box.env.CODEX_THREAD_ID = 'unrelated-reviewer-session-1085';
  document(box.run(review, 'takeover', '--json'));
  const offered = document(box.run(review, 'next', '--verify', String(id), '--json'));
  assert.equal(offered.item.item_id, id, 'an unrelated session is offered the submitted work');
  assert.notEqual(store.getItem(board, id).item_review_by, first);
});

/**
 * Record the builder's submit as a board move with no sealed gate proof. verify then has no submit proof to reuse and runs
 * the armed frozen check itself; the cases below observe that run [C7,V4].
 */
function submitUnsealed(box) {
  // @pullboard-board-file journey: share the board file the real verify command reads
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    submitFixture(board, 1, { agentId: document(box.run(box.web, 'whoami', '--json')).id,
      commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      policyCommit: box.git(box.repo, 'rev-parse', 'main') });
  } finally {
    store.closeBoard(board);
  }
}

/**
 * Move only a private fixture's main during a real frozen check, then inspect the exact checked source. Since #2501
 * (61b93a7c77) verify retries only when its frozen check is red and main fails the same red (knownMain): an unrelated
 * green move keeps the verdict. So the retry modes also run web/known.test.js, red identically on main and owned by an
 * open Main red repair, which makes the retry path the one these cases observe [V4,V8].
 */
function movingReview(t, mode) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  delete box.env.NODE_TEST_CONTEXT; // Main's comparison run must print its own TAP, not report to this runner.
  // Private check environments deliberately discard inherited author settings.
  box.git(box.repo, 'config', 'user.name', 'Review fixture');
  box.git(box.repo, 'config', 'user.email', 'review@example.invalid');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/feature.js'), 'original\n');
  const knownRed = mode !== 'conflict';
  if (knownRed) {
    writeFileSync(join(box.repo, 'web/known.test.js'), "const assert = require('node:assert/strict');\nconst { test } = require('node:test');\ntest('known main red [G1]', () => assert.equal(1, 2));\n");
    const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
    writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap' }, null, 2));
  }
  box.git(box.repo, 'add', '-A');
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
  if (${JSON.stringify(knownRed)}) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const red = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'web/known.test.js'], { encoding: 'utf8', env });
    process.stdout.write(red.stdout ?? ''); process.stderr.write(red.stderr ?? '');
    process.exitCode = red.status ?? 1;
  }
}
`);
  document(fixtureAdd(box.run, box.repo, 'web', 'Review moving main', '--criterion', 'the feature builds', '--specs', 'G1', '--check', `node '${script}'`, '--json'));
  if (knownRed) document(fixtureAdd(box.run, box.repo, 'web', 'Main red: web/known.test.js', '--criterion', 'known main red [G1] passes on main', '--specs', 'G1', '--check', 'node --test web/known.test.js', '--json'));
  document(box.run(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  submitUnsealed(box);
  const before = document(box.run(box.repo, 'show', '1', '--json'));
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, before.item_commit);
  document(joinFixtureSeat(box, reviewer, 'api'));
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

/**
 * Submit and verify one frozen check whose duration the test sets. The check passes instantly during submit (unarmed),
 * then sleeps delayMs when verify runs it (armed); delayMs of -1 hangs until its ceiling stops it.
 */
function frozenCheckCeiling(t, { checkTimeout, landingTimeout, delayMs }) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const armed = join(box.dir, 'check-armed');
  const script = join(box.dir, 'slow-check.cjs');
  writeFileSync(script, `const fs = require('node:fs');
const cell = new Int32Array(new SharedArrayBuffer(4));
if (fs.existsSync(${JSON.stringify(armed)})) {
  const delay = ${delayMs};
  if (delay < 0) for (;;) Atomics.wait(cell, 0, 0, 1000);
  Atomics.wait(cell, 0, 0, delay);
}
console.log('TAP version 13\\nok 1 - slow frozen check\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0');
`);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.check = { install: '', timeout: checkTimeout };
  config.landing = { timeout: landingTimeout };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure frozen check ceiling');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  document(fixtureAdd(box.run, box.repo, 'web', 'Verify a slow frozen check', '--criterion', 'the feature builds', '--specs', 'G1', '--check', `node '${script}'`, '--json'));
  document(box.run(box.web, 'claim', '1', '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]').status, 0);
  submitUnsealed(box);
  const submitted = document(box.run(box.repo, 'show', '1', '--json'));
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted.item_commit);
  document(joinFixtureSeat(box, reviewer, 'api'));
  writeFileSync(armed, 'armed');
  const result = box.run(reviewer, 'verify', '1', 'accept', '--note', 'Observed the frozen check against its configured ceiling.', '--json');
  return { box, result };
}

test('verify runs a frozen check past the check timeout up to the configured landing.timeout [C7,V18]', t => {
  // A 300ms check.timeout stands in for the default 5m; the 1s check runs past it and inside landing.timeout.
  const { box, result } = frozenCheckCeiling(t, { checkTimeout: '300ms', landingTimeout: '20s', delayMs: 1000 });
  assert.equal(result.code, 0, result.err || result.out);
  assert.equal(document(box.run(box.repo, 'show', '1', '--json')).item_status, 'verified');
});

test('a frozen check that hangs stops at the configured ceiling and names the check and elapsed time [C7,V18]', t => {
  const { result } = frozenCheckCeiling(t, { checkTimeout: '300ms', landingTimeout: '1s', delayMs: -1 });
  assert.equal(result.code, 1, result.out);
  const error = JSON.parse(result.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /check timed out after \d+\.\d seconds against its 1\.0 second ceiling/);
  assert.match(error.message, /slow-check\.cjs/);
  assert.match(error.message, /check timed out after [0-9]+\.[0-9] seconds/);
});
