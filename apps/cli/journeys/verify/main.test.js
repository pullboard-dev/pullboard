/** Historical item authors cannot judge their own work after another seat takes over [V1,B3,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe } from 'node:test';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/board/tests/fixtures/cell-board.js";
import { requireSessionIndependence } from "../../tests/fixtures/testkit.js";
import { joinFixtureSeat } from "../../tests/fixtures/testkit.js";
import { submitFixture } from "../../tests/fixtures/board/submit.js";
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { document } from '../../tests/fixtures/verify/unsealed.js';
import { submitUnsealed } from '../../tests/fixtures/verify/unsealed.js';
import { reviewFolder } from "../../../../packages/git/src/io/review-folder.js";
import { lockfileHash } from "../../../runner/src/io/worker/checkout.js";
import { receipt } from "../../../runner/src/io/worker/receipt.js";

/** A refusal leaves the submitted item and event stream untouched. */
async function refused(box, board, cwd, args, expected) {
  const before = store.events(board);
  const result = await box.runIn(cwd, ...args, '--json');
  assert.equal(result.code, 1, result.err || result.out);
  assert.equal(JSON.parse(result.out).error.code, expected, result.out);
  assert.deepEqual(store.events(board), before);
  assert.equal(store.getItem(board, 1).item_review_by, null);
}

// Every case builds its own project and board, so the cases run side by side: the sync setup is short and the frozen checks and verifies dominate.
describe('verify journeys [V4,C7]', { concurrency: true }, () => {
  test('clause 1, clause 2: a reviewer is refused for any item its session ever built [V1,B3,C7]', async (t) => {
    const helpers = createE2eHelpers();
    t.after(helpers.cleanup);
    const box = helpers.project('true');
    // @pullboard-board-file journey: share the board file the real verify command reads
    const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
    t.after(() => store.closeBoard(board));
    const first = document(await box.runIn(box.web, 'whoami', '--json')).id;
    // Bind an original seat without writing a claim digest. Native/legacy moves still name their agent in events.
    box.env.CODEX_THREAD_ID = 'historical-author-session-1085';
    document(await box.runIn(box.web, 'shout', 'all', 'the original author is here', '--json'));
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
    const committed = await helpers.commitFile(box, secondPath, 'web/ready.txt', 'ready\n', 'feat(web): finish the handed-over item [G1]');
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
    await refused(box, board, review, ['next','--verify',String(id)], 'SELF_SESSION_VERIFY');
    // A next --verify with nothing free records its idle cause once, then dedupes the same cause: record it here so the refusal below leaves the stream untouched.
    assert.equal(JSON.parse((await box.runIn(review, 'next', '--verify', '--json')).out).error.code, 'NOTHING_FREE');
    await refused(box, board, review, ['next','--verify'], 'NOTHING_FREE');
    await refused(box, board, review, ['verify',String(id),'reject','--reason','TEST_FAILURE','--note','synthetic review attempt'], 'SELF_SESSION_VERIFY');
    box.env.CODEX_THREAD_ID = 'unrelated-reviewer-session-1085';
    document(await box.runIn(review, 'takeover', '--json'));
    const offered = document(await box.runIn(review, 'next', '--verify', String(id), '--json'));
    assert.equal(offered.item.item_id, id, 'an unrelated session is offered the submitted work');
    assert.notEqual(store.getItem(board, id).item_review_by, first);
  });

  /**
   * Move only a private fixture's main during a real frozen check, then inspect the exact checked source. Since #2501
   * (61b93a7c77) verify retries only when its frozen check is red and main fails the same red (knownMain): an unrelated
   * green move keeps the verdict. So the retry modes also run web/known.test.js, red identically on main and owned by an
   * open Main red repair, which makes the retry path the one these cases observe [V4,V8].
   */
  async function movingReview(t, mode) {
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
    document(await fixtureAdd(box.runIn, box.repo, 'web', 'Review moving main', '--criterion', 'the feature builds', '--specs', 'G1', '--check', `node '${script}'`, '--json'));
    if (knownRed) document(await fixtureAdd(box.runIn, box.repo, 'web', 'Main red: web/known.test.js', '--criterion', 'known main red [G1] passes on main', '--specs', 'G1', '--check', 'node --test web/known.test.js', '--json'));
    document(await box.runIn(box.web, 'claim', '1', '--json'));
    assert.equal((await helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]')).status, 0);
    await submitUnsealed(box);
    const before = document(await box.runIn(box.repo, 'show', '1', '--json'));
    const reviewer = join(box.dir, 'reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, before.item_commit);
    document(joinFixtureSeat(box, reviewer, 'api'));
    writeFileSync(armed, 'armed');
    const result = await box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'Observed the frozen check at each exact private source.', '--json');
    const after = document(await box.runIn(box.repo, 'show', '1', '--json'));
    assert.equal(after.item_commit, before.item_commit, 'retry preserves the submitted head');
    assert.equal(after.item_frozen_digest, before.item_frozen_digest, 'retry preserves the frozen bar');
    assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), before.item_commit, 'retry never changes the live reviewer checkout');
    return { box, result, after, before, runs: JSON.parse(readFileSync(runs, 'utf8')) };
  }

  test('verify retries once at the clean new-main composition and binds its real source [V4,V8]', async t => {
    const { box, result, after, before, runs } = await movingReview(t, 'once');
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

  test('verify preserves a real main merge conflict without a retry or verdict [V4,V8]', async t => {
    const { result, after, runs } = await movingReview(t, 'conflict');
    assert.equal(JSON.parse(result.out).error.code, 'MERGE_CONFLICT');
    assert.equal(runs.length, 1);
    assert.equal(after.item_status, 'submitted');
    assert.deepEqual(after.verdicts, []);
  });

  test('verify refuses a second main move after its one retry [V4,V8]', async t => {
    const { result, after, runs } = await movingReview(t, 'twice');
    assert.equal(JSON.parse(result.out).error.code, 'VERDICT_TRUNK_MOVED');
    assert.equal(runs.length, 2, 'there is no third frozen check');
    assert.equal(after.item_status, 'submitted');
    assert.deepEqual(after.verdicts, []);
  });

  const LOCKFILE = '{"lockfileVersion":3}\n';

  /** A submitted item whose frozen check records where it ran, and a reviewer checkout that holds an untracked file so the review leaves it alone [C7,#1112]. */
  async function submittedForReview(t) {
    const helpers = createE2eHelpers();
    t.after(helpers.cleanup);
    const box = helpers.project('true');
    box.git(box.repo, 'config', 'user.name', 'Review fixture');
    box.git(box.repo, 'config', 'user.email', 'review@example.invalid');
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, 'web/feature.js'), 'original\n');
    writeFileSync(join(box.repo, 'package-lock.json'), LOCKFILE);
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'test: initial feature [G1]');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const ranIn = join(box.dir, 'ran-in.json');
    const script = join(box.dir, 'check.cjs');
    writeFileSync(script, `const fs = require('node:fs');
  fs.writeFileSync(${JSON.stringify(ranIn)}, JSON.stringify({ cwd: fs.realpathSync(process.cwd()), seatFile: fs.existsSync('seat-only.txt'), feature: fs.readFileSync('web/feature.js', 'utf8') }));
  `);
    document(await fixtureAdd(box.runIn, box.repo, 'web', 'Review in a board tree', '--criterion', 'the feature builds', '--specs', 'G1', '--check', `node '${script}'`, '--json'));
    document(await box.runIn(box.web, 'claim', '1', '--json'));
    assert.equal((await helpers.commitFile(box, box.web, 'web/feature.js', 'built\n', 'feat(web): build feature [G1]')).status, 0);
    await submitUnsealed(box);
    const submitted = document(await box.runIn(box.repo, 'show', '1', '--json'));
    const reviewer = join(box.dir, 'reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted.item_commit);
    writeFileSync(join(reviewer, 'seat-only.txt'), 'only in the reviewer checkout\n');
    document(joinFixtureSeat(box, reviewer, 'api'));
    rmSync(ranIn, { force: true }); // the claim and submit steps may run the check once; only the review's own run is observed
    const parent = join(box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'pullboard-review-folders');
    return { box, submitted, reviewer, ranIn, folder: join(parent, submitted.item_commit), parent };
  }

  test('cli.journeys-verify-main.review-in-board-tree: clause 1: a review of a submitted item runs its frozen check in the board-made review folder at the submitted commit and records verdict_isolated true [C7,#1112]', async t => {
    const { box, submitted, reviewer, ranIn, folder } = await submittedForReview(t);
    assert.equal(existsSync(folder), false, 'no review folder exists before the review');
    document(await box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'Observed the frozen check at the exact submitted commit.', '--json'));
    assert.equal(box.git(folder, 'rev-parse', 'HEAD'), submitted.item_commit, 'the board made a review folder at the submitted commit');
    const ran = JSON.parse(readFileSync(ranIn, 'utf8'));
    assert.notEqual(ran.cwd, box.git(reviewer, 'rev-parse', '--show-toplevel'), 'the frozen check ran outside the reviewer checkout');
    assert.equal(ran.feature, 'built\n', 'the check read the submitted commit');
    assert.equal(ran.seatFile, false, 'the check never saw the reviewer checkout');
    assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), submitted.item_commit, 'the reviewer checkout is left alone');
    // @pullboard-board-file journey: a read-only look at the verdict row and the board_meta row the real verify command wrote.
    const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
    try {
      const verdict = db.prepare('SELECT MAX(verdict_id) AS id FROM verdict WHERE item_id=1').get().id;
      assert.ok(verdict, 'the review recorded a verdict');
      assert.equal(db.prepare('SELECT meta_value AS value FROM board_meta WHERE meta_key = ?').get(`verdict_isolated:${verdict}`)?.value, 'true');
    } finally { db.close(); }
  });

  test('cli.journeys-verify-main.linked-deps-refused: clause 2: a review folder whose node_modules links to another checkout is refused DEPS_OUTSIDE_TREE by name [C7,#1112]', async t => {
    const { box, submitted, reviewer, ranIn, folder } = await submittedForReview(t);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', folder, submitted.item_commit);
    const elsewhere = join(box.dir, 'another-checkout');
    mkdirSync(elsewhere);
    mkdirSync(join(folder, 'node_modules'), { recursive: true });
    symlinkSync(elsewhere, join(folder, 'node_modules', 'left-pad'));
    const result = await box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'Observed the frozen check at the exact submitted commit.', '--json');
    assert.equal(result.code, 1, result.err || result.out);
    const error = JSON.parse(result.out).error;
    assert.equal(error.code, 'DEPS_OUTSIDE_TREE', result.out);
    assert.match(error.message, /left-pad/u, 'the refusal names the linked package');
    assert.equal(existsSync(ranIn), false, 'the frozen check never ran in the linked tree');
    const after = document(await box.runIn(box.repo, 'show', '1', '--json'));
    assert.equal(after.item_status, 'submitted');
    assert.deepEqual(after.verdicts, []);
  });

  test('cli.journeys-verify-main.receipt-tree-and-deps: clause 3: the runner receipt for the review tree carries the tree and the sha256 of its lockfile [C7,#1112]', async t => {
    const { box, submitted, parent } = await submittedForReview(t);
    const { folder } = reviewFolder(box.repo, submitted.item_commit, parent);
    const tree = box.git(folder, 'rev-parse', 'HEAD^{tree}');
    assert.equal(tree, box.git(box.web, 'rev-parse', 'HEAD^{tree}'), 'the review folder holds the submitted tree');
    const spec = { id: 'review-1', commit: submitted.item_commit, tree, runtime: { sha256: 'r' }, tooling: { sha256: 'u' } };
    const sink = { hash: createHash('sha256'), wallStart: Date.now() };
    const original = process.stderr.write;
    let line = '';
    process.stderr.write = (chunk, ...rest) => { line += String(chunk); const done = rest.find(arg => typeof arg === 'function'); if (done) done(); return true; };
    try { await receipt(spec, { code: 0, signal: null, executionPhases: {}, dependencies: lockfileHash(folder) }, sink); } finally { process.stderr.write = original; }
    const body = JSON.parse(Buffer.from(line.trim().split(' ')[2], 'base64').toString('utf8'));
    assert.equal(body.commit, submitted.item_commit);
    assert.equal(body.tree, tree);
    assert.equal(body.dependencies, createHash('sha256').update(LOCKFILE).digest('hex'));
  });
});
