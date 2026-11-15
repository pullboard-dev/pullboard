/** The finish sequence writes each of its six steps as a job step, resumes from the log, reuses a green receipt and stops on a red proof [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { treeOf } from '../../../pin/index.js';
import { toolingPin } from '../../../pin/index.js';
import { receiptKey } from '../../../receipt/index.js';
import { FINISH_STEPS } from '../../index.js';
import { finishSequence } from '../../index.js';
import { nextFinishStep } from '../../index.js';
import { writtenSteps } from '../../index.js';

const refused = code => error => error.code === code;

/** A repo with a base commit and a candidate on top, a board's db, and a landing job named `land:1`. */
function landing(t) {
  const repo = cellRepo(t, {});
  repo.put('feature.txt', 'candidate\n');
  const candidate = repo.commitAll();
  const db = cellBoard(t, ':memory:').db;
  createJob(db, { id: 'land:1', kind: 'landing', item: 1, candidate, base: repo.commit, now: 1 });
  return { repo: repo.root, base: repo.commit, candidate, db };
}

/** Handlers for all six steps that record when they ran and what they were handed. */
function handlers({ base, candidate }, over = {}) {
  const calls = [];
  const note = (name, result) => context => { calls.push([name, context]); return result; };
  const steps = {
    select: note('select', { items: [1] }),
    compose: note('compose', { candidate, base }),
    prove: note('prove', { verdict: 'green', runner: 'mini' }),
    merge: note('merge', { commit: candidate }),
    record: note('record', { recorded: true }),
    publish: note('publish', undefined),
    ...over,
  };
  return { steps, calls };
}

test('the finish steps are six, in order, and the next one is read from what the log holds [C7]', () => {
  assert.deepEqual(FINISH_STEPS, ['select', 'compose', 'prove', 'merge', 'record', 'publish']);
  assert.equal(Object.isFrozen(FINISH_STEPS), true);
  assert.equal(nextFinishStep({ steps: [] }), 'select');
  assert.equal(nextFinishStep({ steps: [{ name: 'select' }, { name: 'compose' }] }), 'prove');
  assert.equal(nextFinishStep({ steps: [{ name: 'select' }, { name: 'prove' }] }), 'compose', 'the first gap is next, whatever was written after it');
  assert.equal(nextFinishStep({ steps: FINISH_STEPS.map(name => ({ name })) }), null);
  const written = writtenSteps({ steps: [{ name: 'select', payload: { a: 1 } }, { name: 'select', payload: { a: 2 } }, { name: 'gate-note', payload: {} }, { name: 'merge', payload: { commit: 'c' } }] });
  assert.deepEqual(written, { select: { a: 1 }, merge: { commit: 'c' } }, 'the first payload of a step wins and foreign steps are ignored');
});

test('a landing runs all six steps in order, each handed what the earlier ones wrote, and ends done with its lease released [C7]', async t => {
  const land = landing(t);
  const { steps, calls } = handlers(land);
  const result = await finishSequence(land.db, 'land:1', { owner: 'driver-1', repo: land.repo, steps });
  assert.equal(result.done, true);
  assert.deepEqual(result.ran, FINISH_STEPS);
  assert.deepEqual(calls.map(([name]) => name), FINISH_STEPS);
  assert.deepEqual(Object.keys(calls[3][1].written), ['select', 'compose', 'prove'], 'merge sees the three steps before it');
  assert.equal(calls[3][1].repo, land.repo);

  const view = jobView(land.db, 'land:1');
  assert.equal(view.step, 'done');
  assert.equal(view.leaseOwner, null);
  const payload = Object.fromEntries(view.steps.map(step => [step.name, step.payload]));
  assert.deepEqual([payload.compose.candidateTree, payload.compose.baseTree], [treeOf(land.repo, land.candidate), treeOf(land.repo, land.base)], 'compose names its commits by tree id');
  assert.deepEqual([payload.prove.reused, payload.prove.receipt, payload.prove.code, payload.prove.verdict],
    [false, receiptKey(payload.compose.candidateTree, payload.compose.baseTree), 'NO_RECEIPT', 'green']);
  assert.equal(payload.merge.commit, land.candidate);
  assert.equal(payload.merge.tooling, treeOf(land.repo, land.candidate));
  assert.deepEqual(toolingPin(land.repo), { tree: payload.merge.tooling, commit: land.candidate }, 'the landing is the one writer of the tooling pin');
  assert.deepEqual(payload.publish, {}, 'a step that answers nothing writes an empty payload');
});

test('a finished landing runs nothing again, and a resumed one skips every step its log holds [C7]', async t => {
  const land = landing(t);
  const first = handlers(land, { record: () => { throw new Error('killed during record'); } });
  await assert.rejects(finishSequence(land.db, 'land:1', { owner: 'driver-1', repo: land.repo, steps: first.steps }), /killed during record/u);
  assert.deepEqual(first.calls.map(([name]) => name), ['select', 'compose', 'prove', 'merge']);
  assert.equal(jobView(land.db, 'land:1').step, 'merge', 'the log holds the progress, not the process');

  const second = handlers(land);
  const resumed = await finishSequence(land.db, 'land:1', { owner: 'driver-1', repo: land.repo, steps: second.steps });
  assert.deepEqual(resumed.ran, ['record', 'publish']);
  assert.deepEqual(second.calls.map(([name]) => name), ['record', 'publish']);
  assert.equal(second.calls[0][1].written.merge.commit, land.candidate, 'later steps read earlier payloads from the log');

  const third = handlers(land);
  const again = await finishSequence(land.db, 'land:1', { owner: 'driver-2', repo: land.repo, steps: third.steps });
  assert.deepEqual([again.done, again.ran, third.calls], [true, [], []]);
});

test('a green receipt at exactly the composition\'s trees is reused and prove does not run; any other receipt is not [C7]', async t => {
  const land = landing(t);
  const candidateTree = treeOf(land.repo, land.candidate);
  const baseTree = treeOf(land.repo, land.base);
  const reused = handlers(land, { prove: () => assert.fail('a proved composition is not proved again') });
  const result = await finishSequence(land.db, 'land:1', { owner: 'd', repo: land.repo, steps: reused.steps, receipts: [{ candidate: candidateTree, base: baseTree, verdict: 'green' }] });
  const prove = result.job.steps.find(step => step.name === 'prove').payload;
  assert.deepEqual(prove, { receipt: receiptKey(candidateTree, baseTree), reused: true, verdict: 'green', code: null });

  const other = landing(t);
  let proves = 0;
  const ran = handlers(other, { prove: () => { proves += 1; return { verdict: 'green' }; } });
  const key = receiptKey(treeOf(other.repo, other.candidate), treeOf(other.repo, other.base));
  const red = { candidate: treeOf(other.repo, other.candidate), base: treeOf(other.repo, other.base), verdict: 'red' };
  const done = await finishSequence(other.db, 'land:1', { owner: 'd', repo: other.repo, steps: ran.steps, receipts: new Map([[key, red]]) });
  assert.equal(done.job.steps.find(step => step.name === 'prove').payload.code, 'NOT_GREEN');
  assert.equal(proves, 1, 'a red receipt is not reused');
});

test('a red or infra proof stops the landing before merge, and a later run stays stopped [C7]', async t => {
  const land = landing(t);
  const red = handlers(land, { prove: () => ({ verdict: 'red', code: 'TEST_FAILURE' }) });
  const stopped = await finishSequence(land.db, 'land:1', { owner: 'd', repo: land.repo, steps: red.steps });
  assert.deepEqual([stopped.done, stopped.stopped, stopped.code], [false, 'prove', 'LAND_PROOF_NOT_GREEN']);
  assert.deepEqual(stopped.ran, ['select', 'compose', 'prove']);
  assert.equal(red.calls.some(([name]) => name === 'merge'), false);
  assert.equal(toolingPin(land.repo), null, 'no merge, so no tooling pin');

  const again = handlers(land);
  const still = await finishSequence(land.db, 'land:1', { owner: 'd', repo: land.repo, steps: again.steps });
  assert.deepEqual([still.done, still.code, still.ran, again.calls], [false, 'LAND_PROOF_NOT_GREEN', [], []]);
});

test('a landing whose live lease another driver holds is left alone, and it continues once the lease lapsed [C7]', async t => {
  const land = landing(t);
  takeJob(land.db, 'land:1', 'driver-1', { now: 1000, leaseMs: 1000 });
  const blocked = handlers(land);
  const left = await finishSequence(land.db, 'land:1', { owner: 'driver-2', repo: land.repo, steps: blocked.steps, now: () => 1500 });
  assert.deepEqual([left.done, left.code, left.ran, blocked.calls], [false, 'JOB_LEASED', [], []]);
  const free = handlers(land);
  const taken = await finishSequence(land.db, 'land:1', { owner: 'driver-2', repo: land.repo, steps: free.steps, now: () => 2500 });
  assert.equal(taken.done, true);
});

test('the sequence refuses a missing owner, repo, job or step handler, and a step that answers the wrong shape [C7]', async t => {
  const land = landing(t);
  const full = () => handlers(land).steps;
  await assert.rejects(finishSequence(land.db, 'land:1', { repo: land.repo, steps: full() }), refused('LAND_OWNER'));
  await assert.rejects(finishSequence(land.db, 'land:1', { owner: 'd', steps: full() }), refused('LAND_REPO'));
  await assert.rejects(finishSequence(land.db, 'land:none', { owner: 'd', repo: land.repo, steps: full() }), refused('JOB_MISSING'));
  const { select: _select, ...noSelect } = full();
  await assert.rejects(finishSequence(land.db, 'land:1', { owner: 'd', repo: land.repo, steps: noSelect }), refused('LAND_STEP_HANDLER'));
  const cases = [['compose', () => ({ candidate: 'nope', base: land.base }), 'LAND_COMPOSE'], ['prove', () => ({ ok: true }), 'LAND_PROVE'], ['merge', () => ({ commit: 'nope' }), 'LAND_MERGE']];
  for (const [name, handler, code] of cases) {
    const fresh = landing(t);
    await assert.rejects(finishSequence(fresh.db, 'land:1', { owner: 'd', repo: fresh.repo, steps: handlers(fresh, { [name]: handler }).steps }), refused(code), name);
    assert.equal(jobView(fresh.db, 'land:1').steps.some(step => step.name === name), false, `${name} wrote no step`);
  }
});
