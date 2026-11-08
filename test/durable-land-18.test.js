/** Durable gate 18/20: the landing finish sequence's six steps are job steps; a resumed landing continues [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { createJob, LEASE_MS } from '../packages/jobs/index.js';
import { toolingPin, treeOf } from '../packages/pin/index.js';
import { FINISH_STEPS, finishSequence } from '../packages/land/index.js';

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
  const files = privateFixtureFiles('pullboard-land18-board-');
  const board = openBoard(join(files.root, 'board.sqlite'));
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
    assert.deepEqual(payload('prove'), { receipt: `${treeOf(repo, candidate)}@${treeOf(repo, base)}`, reused: true, verdict: 'green', code: null });
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
