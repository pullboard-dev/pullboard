/** @pullboard-test-input apps/cli/src/io/commands/merged.js apps/cli/src/io/commands/land.js */
/** Durable gate 18/20: the landing finish sequence's six steps are job steps; a resumed landing continues [C7].  * @pullboard-test-input source-tree
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { openBoard } from '../../index.js';
import { closeBoard } from '../../index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../packages/jobs/index.js';
import { toolingPin } from '../../../../packages/pin/index.js';
import { treeOf } from '../../../../packages/pin/index.js';
import { FINISH_STEPS } from '../../../../packages/land/index.js';
import { finishSequence } from '../../../../packages/land/index.js';
import { readFileSync } from 'node:fs';
import { jobView } from '../../../../packages/jobs/index.js';
import { batchLandingJobId } from '../../../../packages/land/index.js';
import { landBatch } from '../../../../packages/land/index.js';
import { landMerged } from '../../../../packages/land/index.js';
import { mergedLandingJobId } from '../../../../packages/land/index.js';

/** A repo with a trunk commit and a candidate commit on top of it. */
function landingRepo() {
  const files = privateFixtureFiles('pullboard-land18-repo-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'land@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Land Test']);
  files.write('app.txt', 'trunk\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'trunk']);
  const base = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('app.txt', 'candidate\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'candidate']);
  const candidate = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  runFixtureGit(['-C', repo, 'update-ref', 'refs/heads/trunk', base]);
  return { repo, base, candidate };
}

/** Open a fresh real board file and hand its SQLite handle to the body. */
async function withBoard(body) {
  const board = openBoard(':memory:');
  try { return await body(board.db); } finally { closeBoard(board); }
}

/**
 * Step handlers that count their calls and do real work in the repo: merge moves trunk to the candidate.
 *
 * @param {{ repo: string, base: string, candidate: string }} fixture
 * @param {{ failAt?: string, verdict?: string }} [options] - failAt makes that step throw, as a driver dying mid-step.
 */
function handlers({ repo, base, candidate }, { failAt = null, verdict = 'green' } = {}) {
  const calls = Object.fromEntries(FINISH_STEPS.map(name => [name, 0]));
  const seen = {};
  const step = (name, work) => async context => {
    calls[name] += 1;
    seen[name] = context.written;
    if (name === failAt) throw new Error(`driver died in ${name}`);
    return work(context);
  };
  const steps = {
    select: step('select', () => ({ items: [3419] })),
    compose: step('compose', () => ({ candidate, base })),
    prove: step('prove', () => ({ verdict })),
    merge: step('merge', () => {
      runFixtureGit(['-C', repo, 'update-ref', 'refs/heads/trunk', candidate]);
      return { commit: runFixtureGit(['-C', repo, 'rev-parse', 'refs/heads/trunk']) };
    }),
    record: step('record', ({ written }) => ({ merged: written.merge.commit, items: written.select.items })),
    publish: step('publish', () => ({ published: true })),
  };
  return { steps, calls, seen };
}

test('clause 1: the six landing steps are job steps written in order, merge writes the tooling pin and prove reuses a keyed receipt [C7]', async () => {
  const fixture = landingRepo();
  const { repo, base, candidate } = fixture;
  await withBoard(async db => {
    createJob(db, { id: 'land-1', kind: 'landing', now: 1 });
    const { steps, calls, seen } = handlers(fixture);
    const receipts = [{ candidate: treeOf(repo, candidate), base: treeOf(repo, base), verdict: 'green' }];
    const result = await finishSequence(db, 'land-1', { owner: 'lander-a', repo, steps, receipts, now: () => 10_000 });

    assert.equal(result.done, true);
    assert.deepEqual(result.ran, FINISH_STEPS);
    assert.deepEqual(result.job.steps.map(s => s.name), ['select', 'compose', 'prove', 'merge', 'record', 'publish'], 'each step is a job step, in order');
    assert.equal(result.job.step, 'publish');
    const payload = name => result.job.steps.find(s => s.name === name).payload;
    assert.deepEqual(payload('compose'), { candidate, base, candidateTree: treeOf(repo, candidate), baseTree: treeOf(repo, base) });
    // The receipt key carries the tooling tree (1411384ebb); with no pin yet it is the candidate's own tree.
    assert.deepEqual(payload('prove'), { receipt: `${treeOf(repo, candidate)}@${treeOf(repo, base)}@${treeOf(repo, candidate)}`, reused: true, verdict: 'green', code: null });
    assert.equal(calls.prove, 0, 'a green receipt at the composition trees is reused, not run');
    assert.deepEqual(payload('merge'), { commit: candidate, tooling: treeOf(repo, candidate) });
    assert.deepEqual(toolingPin(repo), { tree: treeOf(repo, candidate), commit: candidate }, 'merge writes the tooling pin for the landed commit');
    assert.deepEqual(payload('record'), { merged: candidate, items: [3419] });
    assert.deepEqual(seen.record.select, { items: [3419] }, 'later steps get the payloads earlier steps wrote');
    for (const name of ['select', 'compose', 'merge', 'record', 'publish']) assert.equal(calls[name], 1, `${name} ran once`);

    const again = await finishSequence(db, 'land-1', { owner: 'lander-b', repo, steps, receipts, now: () => 20_000 });
    assert.equal(again.done, true);
    assert.deepEqual(again.ran, [], 'a finished landing runs nothing again');
    assert.equal(again.job.steps.length, 6, 'no step is doubled');
  });
});

test('clause 1: a resumed landing continues from its last written step and never reruns a written one [C7]', async () => {
  const fixture = landingRepo();
  const { repo, candidate } = fixture;
  await withBoard(async db => {
    createJob(db, { id: 'land-2', kind: 'landing', now: 1 });
    const first = handlers(fixture, { failAt: 'record', verdict: 'green' });
    await assert.rejects(finishSequence(db, 'land-2', { owner: 'lander-a', repo, steps: first.steps, now: () => 10_000 }), /driver died in record/);

    const second = handlers(fixture);
    const blocked = await finishSequence(db, 'land-2', { owner: 'lander-b', repo, steps: second.steps, now: () => 10_000 + LEASE_MS - 1 });
    assert.equal(blocked.code, 'JOB_LEASED', 'a live lease keeps a second driver out');
    assert.deepEqual(blocked.ran, []);

    const resumed = await finishSequence(db, 'land-2', { owner: 'lander-b', repo, steps: second.steps, now: () => 10_000 + LEASE_MS + 1 });
    assert.equal(resumed.done, true);
    assert.deepEqual(resumed.ran, ['record', 'publish'], 'the resumed landing continues at the step the dead driver owed');
    for (const name of ['select', 'compose', 'prove', 'merge']) assert.equal(second.calls[name], 0, `${name} is not rerun on resume`);
    assert.equal(first.calls.prove, 1, 'with no receipt the first driver ran the proof');
    assert.deepEqual(resumed.job.steps.map(s => s.name), FINISH_STEPS);
    assert.equal(resumed.job.leaseOwner, 'lander-b');
    assert.deepEqual(resumed.job.steps.find(s => s.name === 'record').payload, { merged: candidate, items: [3419] }, 'record reads the merge the dead driver wrote');
  });
});

test('a proof that is not green stops the landing before merge, and a resumed landing stays stopped [C7]', async () => {
  const fixture = landingRepo();
  const { repo, base } = fixture;
  await withBoard(async db => {
    createJob(db, { id: 'land-3', kind: 'landing', now: 1 });
    const { steps, calls } = handlers(fixture, { verdict: 'red' });
    const stopped = await finishSequence(db, 'land-3', { owner: 'lander-a', repo, steps, now: () => 10_000 });
    assert.equal(stopped.done, false);
    assert.equal(stopped.code, 'LAND_PROOF_NOT_GREEN');
    assert.deepEqual(stopped.ran, ['select', 'compose', 'prove']);
    assert.equal(stopped.job.steps.find(s => s.name === 'prove').payload.code, 'NO_RECEIPT');
    const again = await finishSequence(db, 'land-3', { owner: 'lander-b', repo, steps, now: () => 10_000 + LEASE_MS + 1 });
    assert.equal(again.code, 'LAND_PROOF_NOT_GREEN');
    assert.equal(calls.merge, 0, 'nothing merges on a red proof');
    assert.equal(runFixtureGit(['-C', repo, 'rev-parse', 'refs/heads/trunk']), base);
    assert.equal(toolingPin(repo), null);
  });
});

/** @pullboard-world-pin: the wiring case reads the merged and land command sources themselves. */
/** Durable gate 19/20: `pullboard merged` and `land` share the land cell's finish sequence; the hand loop retires [C7]. */

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
async function withBoardPart2(body) {
  const board = openBoard(':memory:');
  try { return await body(board.db); } finally { closeBoard(board); }
}

test('clause 1: a hand landing runs the six finish steps once, and a repeat answers the same commit without recording again [C7]', async () => {
  const { repo, base, commit } = landedRepo();
  await withBoardPart2(async db => {
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
  await withBoardPart2(async db => {
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
  await withBoardPart2(async db => {
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

test('clause 1: pullboard merged and pullboard land merged calls the land cell, land only offers the land job, and merged records only inside its record step [C7]', () => {
  const source = name => readFileSync(new URL(`../../../cli/src/io/commands/${name}.js`, import.meta.url), 'utf8');
  const merged = source('merged');
  const land = source('land');
  assert.match(merged, /import \{ landMerged \} from '[./]+packages\/land\/index\.js';/);
  assert.match(merged, /await landMerged\(board\.db, \{/, 'merged runs its landing as the finish sequence');
  // pullboard land only offers the land job since #6807 (land.js LAND_OFFER_ONLY); the runner's land job runs landBatch.
  assert.doesNotMatch(land, /landBatch/, 'land runs no host batch: it offers the land job');
  assert.match(land, /offerLanding\(ctx, ctx\.info\.root/, 'land offers the same runner land job');
  const record = merged.slice(merged.indexOf('const record = async'), merged.indexOf('let announced'));
  assert.equal(merged.match(/ordered\(ctx, board, '(merged|recordTrainLanding)'/g).length, 2);
  assert.match(record, /ordered\(ctx, board, 'merged'/, 'the hand loop retires: the merge record is the record step');
  assert.match(record, /ordered\(ctx, board, 'recordTrainLanding'/);
  assert.match(record, /item_merged_commit === commit\)\) return \{ already: true \}/, 'a recorded merge is never recorded twice');
});
