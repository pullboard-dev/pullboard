/** Real Git, SQLite and ordered-engine coverage for coordinator criterion reopen [V2,V6,H16]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from './fixture-child.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { appliedSequence, applyRelayMove, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Open the real board SQLite file created by the CLI fixture and close it with the test. */
function openFixtureBoard(t, box) {
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return board;
}

/** Create two isolated SQLite replicas from the submitted fixture's real board snapshot. */
function replicaPair(t, box) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-relay-'));
  const source = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const snapshot = exportBoard(source);
  store.closeBoard(source);
  const copies = ['one', 'two'].map((name) => {
    const replica = store.openBoard(join(directory, `${name}.sqlite`));
    importBoard(replica, snapshot);
    return replica;
  });
  t.after(() => {
    for (const replica of copies) store.closeBoard(replica);
    rmSync(directory, { recursive: true, force: true });
  });
  return copies;
}

/** Add, claim and submit a real item through its joined Git worktree. */
function submitFixture(box) {
  const added = box.run(box.repo, 'add', 'web', 'Corrected criterion', '--specs', 'G1', '--criterion', 'The page renders.');
  assert.equal(added.code, 0, added.err);
  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const commit = commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): page [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err);
  return { commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') };
}

/** Reserve the real submission from a separate joined reviewer checkout. */
function reserveFixtureReview(box) {
  const reviewPath = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', reviewPath, '-b', 'review/one');
  const joined = box.run(reviewPath, 'join', 'api');
  assert.equal(joined.code, 0, joined.err);
  const reserved = box.run(reviewPath, 'next', '--verify', '1');
  assert.equal(reserved.code, 0, reserved.err);
  return reviewPath;
}

test('the coordinator reopens a submitted item without a verdict [V2,V6]', (t) => {
  const box = project();
  const submitted = submitFixture(box);
  reserveFixtureReview(box);

  const wrongCaller = box.run(box.web, 'reopen', '1', '--note', 'criterion wording needs correction', '--json');
  assert.equal(wrongCaller.code, 1);
  assert.equal(JSON.parse(wrongCaller.out).error.code, 'COORDINATOR_ONLY');
  const missingNote = box.run(box.repo, 'reopen', '1', '--note', ' ', '--json');
  assert.equal(missingNote.code, 1);
  assert.equal(JSON.parse(missingNote.out).error.code, 'NOTE_REQUIRED');

  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), submitted.commit, 'the coordinator stays at its own head');
  const reopened = box.run(box.repo, 'reopen', '1', '--note', 'correct the frozen criterion, not the work', '--json');
  assert.equal(reopened.code, 0, reopened.err);
  const result = JSON.parse(reopened.out);
  assert.equal(result.version, 1);
  assert.equal(result.id, 1);
  assert.equal(result.commit, submitted.commit);
  const alreadyOpen = box.run(box.repo, 'reopen', '1', '--note', 'try twice', '--json');
  assert.equal(alreadyOpen.code, 1);
  assert.equal(JSON.parse(alreadyOpen.out).error.code, 'NOT_SUBMITTED');

  const board = openFixtureBoard(t, box);
  const item = store.getItem(board, 1);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_commit, submitted.commit, 'the builder’s submitted commit remains on record');
  assert.equal(item.item_built_by, 'web-1');
  assert.equal(item.item_verdict, null, 'reopen records no verifier judgment');
  assert.equal(item.item_verified_by, null);
  assert.equal(item.item_review_by, null, 'the old review reservation is cleared without a release/cooldown');
  assert.deepEqual(store.stats(board), {
    items: { open: 1, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 }, accepted: 0, rejected: 0,
  });
  const last = store.events(board).at(-1);
  assert.equal(last.event_kind, 'reopen');
  assert.equal(last.event_by, 'coordinator');
  assert.deepEqual(JSON.parse(last.event_detail), {
    commit: submitted.commit, note: 'correct the frozen criterion, not the work', judgment: null,
  });
  assert.equal(store.events(board).some((event) => event.event_kind === 'release' && JSON.parse(event.event_detail).review), false);

  const edited = box.run(box.repo, 'edit', '1', '--criterion', 'The page renders a heading.');
  assert.equal(edited.code, 0, edited.err);
  assert.equal(store.getItem(board, 1).item_criterion, 'The page renders a heading.');
});

test('a reopened item resubmits at a new head after a criterion edit [V2,V6,H16]', async (t) => {
  const box = project();
  const submitted = submitFixture(box);
  const reviewPath = reserveFixtureReview(box);
  const copies = replicaPair(t, box);
  assert.ok(ENGINE_VERSION >= 8, 'engine 8 introduces ordered reopen semantics');
  const move = prepareEngineMove(copies[0], 'reopen', [1, {
    agentId: 'coordinator', note: 'replay the no-verdict return',
  }], { id: 'reopen-engine-roundtrip', actor: 'coordinator' });
  assert.equal(move.engine, 8);
  const oldReceiver = store.openBoard(join(box.dir, 'old-engine.sqlite'));
  t.after(() => store.closeBoard(oldReceiver));
  importBoard(oldReceiver, exportBoard(copies[0]));
  const beforeOldReceiver = exportBoard(oldReceiver);
  const oldDirectory = mkdtempSync(join(tmpdir(), 'pullboard-engine-7-reopen-'));
  t.after(() => rmSync(oldDirectory, { recursive: true, force: true }));
  const archive = execFileSync('git', ['archive', 'v0.8.4'], {
    cwd: resolve(import.meta.dirname, '..'), maxBuffer: 32 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', oldDirectory], { input: archive });
  const oldEngine = await import(pathToFileURL(join(oldDirectory, 'src/engine.js')).href);
  const oldMachine = await import(pathToFileURL(join(oldDirectory, 'src/machine.js')).href);
  assert.equal(oldMachine.ENGINE_VERSION, 7, 'exercise the actual released engine-7 client');
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  assert.throws(() => oldEngine.applyRelayMove(oldReceiver, move, {
    sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
  }), (error) => error.code === 'ENGINE_VERSION');
  assert.deepEqual(exportBoard(oldReceiver), beforeOldReceiver, 'the actual engine-7 client refuses before changing rows or replay state');
  assert.equal(appliedSequence(oldReceiver), 0);

  assert.throws(() => applyRelayMove(oldReceiver, { ...move, engine: 7 }, {
    sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
  }), (error) => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(oldReceiver), beforeOldReceiver, 'the current receiver rejects an impossible pre-introduction tag without mutation');

  const first = applyRelayMove(copies[0], move, { sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender });
  const second = applyRelayMove(copies[1], move, { sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender });
  assert.deepEqual(first, second);
  assert.deepEqual(first.result, { id: 1, commit: submitted.commit });
  for (const replica of copies) {
    assert.equal(store.getItem(replica, 1).item_status, 'open');
    assert.equal(store.getItem(replica, 1).item_commit, submitted.commit);
    assert.equal(store.events(replica).at(-1).event_kind, 'reopen');
    assert.equal(JSON.parse(store.events(replica).at(-1).event_detail).judgment, null);
    assert.equal(appliedSequence(replica), 1);
    assert.equal(engineReceipt(replica, move.id).sequence, 1);
  }

  const reopened = box.run(box.repo, 'reopen', '1', '--note', 'correct the frozen criterion');
  assert.equal(reopened.code, 0, reopened.err);
  const edited = box.run(box.repo, 'edit', '1', '--criterion', 'The page renders a heading.');
  assert.equal(edited.code, 0, edited.err);

  const claimed = box.run(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  const sameHead = box.run(box.web, 'submit', '1', '--json');
  assert.equal(sameHead.code, 1);
  assert.equal(JSON.parse(sameHead.out).error.code, 'HEAD_NOT_NEW');
  const treeBefore = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  box.git(box.web, 'commit', '--allow-empty', '-m', 'chore(web): resend corrected criterion at a new head [G1]');
  const newHead = box.git(box.web, 'rev-parse', 'HEAD');
  assert.notEqual(newHead, submitted.commit);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD^{tree}'), treeBefore, 'an empty commit keeps the measured tree unchanged');
  const resubmission = box.run(box.web, 'submit', '1', '--json');
  assert.equal(resubmission.code, 0, resubmission.err);
  assert.equal(JSON.parse(resubmission.out).commit, newHead);
  const board = openFixtureBoard(t, box);
  assert.equal(store.getItem(board, 1).item_commit, newHead);
  const freshReview = box.run(reviewPath, 'next', '--verify', '1');
  assert.equal(freshReview.code, 0, `reopen starts no reviewer cooldown: ${freshReview.err}`);
});
