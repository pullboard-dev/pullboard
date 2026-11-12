/** Prove a plain land takes every waiting accepted item in one batch and bisects a red one out [B3,R3,E26,E29]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import {
  calls,
  events,
  mergeSubjects,
} from './board.js';
import { PHASE_LINE } from '../../../../../packages/landing/index.js';

/** The waiting queue a batch must take whole; the criterion asks for at least sixteen seen. */
export const WAITING = 16;

/** Longest any one phase of the batch may take before the test names it, in milliseconds. */
export const PHASE_BUDGET_MS = 240_000;

/**
 * Run one named phase, print its elapsed time, and fail naming it when it passes the budget.
 * Why: one 300 s hang ceiling hid which phase (seeding, merge and gate, publication) ate the time.
 */
async function timed(phases, name, work) {
  const start = Date.now();
  const value = await work();
  const elapsed = Date.now() - start;
  phases.push([name, elapsed]);
  console.log(`# phase ${name}: ${(elapsed / 1000).toFixed(1)} s`);
  assert.ok(elapsed <= PHASE_BUDGET_MS, `phase "${name}" took ${(elapsed / 1000).toFixed(1)} s, past the ${PHASE_BUDGET_MS / 1000} s budget`); // budget: declared 240 s ceiling per phase from the item criterion, under the 300 s hang ceiling.
  return value;
}

/**
 * Print each landing phase's elapsed time as the landing said it (merge, gate, guardian lease check, push) and fail naming
 * the phase that passed the budget; a phase the landing never said is a missing measurement and fails too [C7].
 */
function landingPhases(phases, output) {
  const totals = new Map();
  for (const line of output.split('\n')) {
    const found = PHASE_LINE.exec(line.trim());
    if (found) totals.set(found[1], (totals.get(found[1]) ?? 0) + Number(found[2]));
  }
  for (const name of ['merge', 'gate', 'lease check', 'push']) {
    assert.ok(totals.has(name), `the landing reported no "${name}" phase time`);
    const elapsed = totals.get(name);
    phases.push([name, elapsed]);
    console.log(`# phase ${name}: ${(elapsed / 1000).toFixed(1)} s`);
    assert.ok(elapsed <= PHASE_BUDGET_MS, `phase "${name}" took ${(elapsed / 1000).toFixed(1)} s, past the ${PHASE_BUDGET_MS / 1000} s budget`); // budget: declared 240 s ceiling per phase from the item criterion, under the 300 s hang ceiling
  }
}

/** Read the gate fixture's own trace of the files each full (non-diagnostic) run tested. */
function allRuns(box) {
  if (!existsSync(box.trace)) return [];
  return readFileSync(box.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** The whole-plan runs alone: a focused bisection round and a single-file diagnosis both run through the affected runner. */
function fullRuns(box) { return allRuns(box).filter(row => !row.alone); }

/**
 * Seed WAITING independent accepted items, one red, then run a plain `pullboard land` with no --max.
 * Why: one landing per item caps the trunk near two items an hour, so the default must be the whole
 * waiting queue in one gate run, and a red batch must cost about log2(n) gates, never n.
 */
export async function assertWholeQueueBatch({ landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal, json, onBoard }, { separate = false } = {}) {
  const box = landProject();
  if (separate) {
    const path = join(box.repo, 'pullboard.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: exercise separate batch publication');
  }
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const red = 10;
  box.env.LAND_SUPPRESS_RED = '1';
  const phases = [];
  const entries = await timed(phases, 'setup', async () => {
    const made = [];
    for (let index = 0; index < WAITING; index += 1) made.push(await itemWorktreeLocal(box, index + 1, `web/land-${index + 1}.test.js`));
    return made;
  });
  // The hooks make a commit slow; the commits are independent, so four run at once, then each submit takes the board in turn.
  await timed(phases, 'commit', async () => {
    for (let at = 0; at < entries.length; at += 4) await Promise.all(entries.slice(at, at + 4).map((entry, offset) => commitItemLocal(box, entry, at + offset === red ? 'RED\n' : 'PASS\n')));
  });
  await timed(phases, 'submit', async () => { for (const entry of entries) await submitItemLocal(box, entry); });
  await timed(phases, 'accept', async () => { for (const entry of entries) await acceptItemLocal(box, entry); });
  // The acceptance proof is for the old main; a real later change makes the batch run its landing gate.
  writeFileSync(join(box.repo, 'main-advance.txt'), 'main changed after acceptance\n');
  box.git(box.repo, 'add', 'main-advance.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main before landing');
  delete box.env.LAND_SUPPRESS_RED;
  const base = box.git(box.repo, 'rev-parse', 'main');
  const batchesBefore = onBoard(box, board => store.landingBatches(board).length);
  const movesBefore = events(box).filter(event => event.event_kind === 'main-moved').length;
  const runsBefore = fullRuns(box).length;
  const allBefore = allRuns(box).length;
  const callsBefore = calls(box).length;

  const landed = await timed(phases, 'land', () => box.run(box.repo, 'land', '--json'));
  assert.equal(landed.code, 0, `${landed.err}\n${landed.out}`);
  const result = JSON.parse(landed.out);
  landingPhases(phases, `${landed.err}\n${(result.diagnostics ?? []).join('\n')}`);

  const ids = entries.map(entry => entry.item);
  const culprit = entries[red].item;
  assert.equal(result.batch.candidates.length, WAITING, 'the batch is sized to every waiting accepted item');
  assert.deepEqual(result.batch.candidates.map(entry => entry.id), ids, 'in verdict order');
  assert.equal(onBoard(box, board => store.landingBatches(board).length), batchesBefore + 1, 'one landing batch, never one per item');
  const runs = fullRuns(box).slice(runsBefore);
  assert.equal(runs[0].files.length, WAITING, 'the first gate run tests the whole queue at once');
  assert.ok(runs.length <= 2 * Math.log2(WAITING) + 2, `a red batch bisects in about log2(n) gates, not n: ${runs.length} full runs`);
  assert.ok(calls(box).length > callsBefore);
  // A bisection round runs only the file the batch failed, through the affected runner, so each half costs one file,
  // not its whole plan; the rebuilt green set still runs the whole plan below [C7].
  const focused = allRuns(box).slice(allBefore).filter(run => run.alone && run.files.length === 1 && run.files[0] === entries[red].file);
  assert.ok(focused.length >= 1, 'every bisection round runs only the failed file');
  assert.equal(runs.at(-1).files.length, WAITING - 1, `the rebuilt green batch is actually evaluated; runs: ${JSON.stringify(allRuns(box).slice(allBefore).map(run => [run.alone ? 'alone' : 'full', run.files]))}; batch ${result.batch.state} ${JSON.stringify(result.batch.refusal ?? null)} landed ${JSON.stringify(result.landed)} culprits ${JSON.stringify(result.culprits?.map(entry => entry.id))}`);

  assert.deepEqual(result.culprits.map(entry => entry.id), [culprit], 'bisection names the item that caused the red');
  assert.equal(result.culprits[0].tests[0].file, entries[red].file);
  assert.equal(json(box, box.repo, 'show', String(culprit)).item_status, 'open', 'the culprit goes back to its builder');
  assert.equal(json(box, box.repo, 'show', String(culprit)).item_merged_commit, null);

  const rest = ids.filter(id => id !== culprit);
  assert.equal(result.batch.state, 'landed');
  assert.deepEqual(result.landed, rest, 'every other item lands in the same batch');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), separate ? remoteBefore : result.batch.tip);
  assert.equal(events(box).filter(event => event.event_kind === 'main-moved').length, movesBefore + 1, 'main moves once for the whole batch');
  const merges = mergeSubjects(box, base, result.batch.tip).filter(subject => subject.includes('(merge):'));
  assert.equal(merges.length, rest.length);
  for (const id of rest) assert.ok(json(box, box.repo, 'show', String(id)).item_merged_commit, `#${id} records its merge`);
}
