/** Prove a plain land takes every waiting accepted item in one batch and bisects a red one out [B3,R3,E26,E29]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../src/board.js';
import { calls, events, mergeSubjects } from './land-board-fixture.js';

/** The waiting queue a batch must take whole; the criterion asks for at least sixteen seen. */
export const WAITING = 16;

/** Read the gate fixture's own trace of the files each full (non-diagnostic) run tested. */
function fullRuns(box) {
  if (!existsSync(box.trace)) return [];
  return readFileSync(box.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.alone);
}

/**
 * Seed WAITING independent accepted items, one red, then run a plain `pullboard land` with no --max.
 * Why: one landing per item caps the trunk near two items an hour, so the default must be the whole
 * waiting queue in one gate run, and a red batch must cost about log2(n) gates, never n.
 */
export function assertWholeQueueBatch({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, { separate = false } = {}) {
  const box = landProject();
  if (separate) {
    const path = join(box.repo, 'pullboard.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), landing: { publish: 'separate' } }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: exercise separate batch publication');
  }
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const red = 10;
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = Array.from({ length: WAITING }, (_, index) => itemWorktree(box, index + 1, `web/land-${index + 1}.test.js`));
  for (const [index, entry] of entries.entries()) submitItem(box, entry, index === red ? 'RED\n' : 'PASS\n');
  for (const entry of entries) acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const base = box.git(box.repo, 'rev-parse', 'main');
  const batchesBefore = onBoard(box, board => store.landingBatches(board).length);
  const movesBefore = events(box).filter(event => event.event_kind === 'main-moved').length;
  const runsBefore = fullRuns(box).length;
  const callsBefore = calls(box).length;

  const result = json(box, box.repo, 'land');

  const ids = entries.map(entry => entry.item);
  const culprit = entries[red].item;
  assert.equal(result.batch.candidates.length, WAITING, 'the batch is sized to every waiting accepted item');
  assert.deepEqual(result.batch.candidates.map(entry => entry.id), ids, 'in verdict order');
  assert.equal(onBoard(box, board => store.landingBatches(board).length), batchesBefore + 1, 'one landing batch, never one per item');
  const runs = fullRuns(box).slice(runsBefore);
  assert.equal(runs[0].files.length, WAITING, 'the first gate run tests the whole queue at once');
  assert.ok(runs.length <= 2 * Math.log2(WAITING) + 2, `a red batch bisects in about log2(n) gates, not n: ${runs.length} full runs`);
  assert.ok(calls(box).length > callsBefore);
  assert.ok(runs.some(run => run.files.length === 1 && run.files[0] === entries[red].file), 'the culprit is evaluated alone');
  assert.equal(runs.at(-1).files.length, WAITING - 1, 'the rebuilt green batch is actually evaluated');

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
