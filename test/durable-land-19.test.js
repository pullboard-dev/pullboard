/** Durable gate 19/20: `pullboard merged` and `land` share the land cell's finish sequence; the hand loop retires [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { fixtureAdd } from './testkit-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { jobView, LEASE_MS } from '../packages/jobs/index.js';
import { toolingPin, treeOf } from '../packages/pin/index.js';
import { FINISH_STEPS, batchLandingJobId, landBatch, landMerged, mergedLandingJobId } from '../packages/land/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A repo with a trunk commit and a landed commit on top of it. */
function landedRepo() {
  const files = privateFixtureFiles('pullboard-land19-repo-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'land@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Land Test']);
  files.write('app.txt', 'trunk\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'trunk']);
  const base = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('app.txt', 'landed\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'landed']);
  return { repo, base, commit: runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']) };
}

/** Open a fresh real board file and hand its SQLite handle to the body. */
async function withBoard(body) {
  const files = privateFixtureFiles('pullboard-land19-board-');
  const board = openBoard(join(files.root, 'board.sqlite'));
  try { return await body(board.db); } finally { closeBoard(board); }
}

test('clause 1: a hand landing runs the six finish steps once, and a repeat answers the same commit without recording again [C7]', async () => {
  const { repo, base, commit } = landedRepo();
  await withBoard(async db => {
    const records = [];
    const options = { repo, ids: [7], commit, base, owner: 'merged:coordinator', now: () => 10_000,
      check: () => ({ checked: true }), record: () => { records.push(commit); return { recorded: records.length }; } };
    const first = await landMerged(db, options);
    assert.equal(first.commit, commit);
    assert.deepEqual(first.ran, FINISH_STEPS, 'merged runs the one finish sequence');
    assert.deepEqual(first.written.select, { items: [7], checked: true });
    assert.deepEqual(first.written.merge, { commit, tooling: treeOf(repo, commit) });
    assert.deepEqual(toolingPin(repo), { tree: treeOf(repo, commit), commit }, 'the hand landing writes the tooling pin');
    const again = await landMerged(db, { ...options, now: () => 20_000 });
    assert.equal(again.commit, commit, 'the merge already happened, so the same commit comes back');
    assert.deepEqual(again.ran, []);
    assert.equal(records.length, 1, 'the board record is written once');
    assert.equal(jobView(db, mergedLandingJobId([7], commit)).steps.length, 6, 'no step is doubled');
  });
});

test('clause 1: a hand landing killed in record resumes from its saved steps and merge answers the same commit [C7]', async () => {
  const { repo, base, commit } = landedRepo();
  await withBoard(async db => {
    const checks = [];
    const options = { repo, ids: [8], commit, base, owner: 'merged:coordinator', check: () => { checks.push(1); return {}; } };
    await assert.rejects(landMerged(db, { ...options, now: () => 10_000, record: () => { throw new Error('killed in record'); } }), /killed in record/);
    const view = jobView(db, mergedLandingJobId([8], commit));
    assert.deepEqual(view.steps.map(step => step.name), ['select', 'compose', 'prove', 'merge']);
    const resumed = await landMerged(db, { ...options, now: () => 10_000 + LEASE_MS + 1, record: () => ({ recorded: true }) });
    assert.deepEqual(resumed.ran, ['record', 'publish'], 'the rerun continues at the step the killed run owed');
    assert.equal(checks.length, 1, 'the checks are not rerun');
    assert.equal(resumed.commit, commit);
  });
});

test('clause 1: land writes a landed batch through the same finish sequence; a repeat or an unlanded batch writes nothing [C7]', async () => {
  const { repo, base, commit } = landedRepo();
  await withBoard(async db => {
    const batch = { id: 'batch-19', state: 'landed', tip: commit, base, items: [{ id: 3 }, { id: 4 }] };
    const landed = await landBatch(db, { repo, batch, owner: 'land:test', now: () => 10_000 });
    assert.equal(landed.commit, commit);
    assert.deepEqual(landed.ran, FINISH_STEPS);
    const view = jobView(db, batchLandingJobId('batch-19'));
    assert.equal(view.kind, 'landing');
    assert.deepEqual(view.steps.find(step => step.name === 'select').payload, { items: [3, 4], batch: 'batch-19' });
    assert.deepEqual(toolingPin(repo), { tree: treeOf(repo, commit), commit });
    assert.deepEqual((await landBatch(db, { repo, batch, owner: 'land:other', now: () => 20_000 })).ran, []);
    assert.equal(await landBatch(db, { repo, batch: { ...batch, id: 'batch-20', state: 'pushed' }, owner: 'land:test' }), null);
  });
});

test('clause 1: pullboard merged records through the landing job, once, and a second run answers the same commit [C7]', () => {
  const box = e2e.project();
  fixtureAdd(box.run, box.repo, 'web', 'Greet', '--route', 'light', '--criterion', 'says Hi', '--check', 'grep -q Hi web/page.js', '--brief', e2e.LIGHT_BRIEF);
  const runner = box.run(box.repo, 'worktree', 'web', '--route', 'light').out.match(/^made (\S+) /)[1];
  const greet = join(box.dir, 'greet.sh');
  writeFileSync(greet, ['#!/bin/sh', 'mkdir -p web', "echo \"export const title = 'Hi';\" > web/page.js", ''].join('\n'));
  assert.match(box.run(runner, 'run', '--agent-light', `sh ${greet}`, '--attempts', '1').out, /submitted #1/);
  const itemCommit = JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit;
  box.git(box.web, 'merge', '-q', '--ff-only', itemCommit);
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--note', 'the page says Hi').out, /verified #1/);
  box.git(box.repo, 'merge', '-q', '--ff-only', itemCommit);
  const first = box.run(box.repo, 'merged', '1', itemCommit);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, new RegExp(`#1 merged as ${itemCommit.slice(0, 12)}`));
  const second = box.run(box.repo, 'merged', '1', itemCommit);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, new RegExp(`#1 merged as ${itemCommit.slice(0, 12)}`), 'the repeat answers the same commit');
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const view = jobView(board.db, mergedLandingJobId([1], itemCommit));
    assert.deepEqual(view.steps.map(step => step.name), FINISH_STEPS, 'merged ran the finish sequence');
    const events = board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'merged' AND item_id = 1").get().n;
    assert.equal(events, 1, 'the merge is recorded once');
  } finally { closeBoard(board); }
  assert.deepEqual(toolingPin(box.repo), { tree: treeOf(box.repo, itemCommit), commit: itemCommit });
});
