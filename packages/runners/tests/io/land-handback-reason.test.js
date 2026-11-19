/** A pull runner given a land job it cannot run hands it back at once with the reason, behind jobs.handBackUnrunnable [C7,#9249]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { serveRunner } from '../../../drive/index.js';
import { testGit as pullGit } from '../fixtures/git.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { backOffLease } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const JOB = 'land:9180:2190060aafd9b6c6';
// The land request #9180's job carried, whose shardProof run the board moved to the request: the claim names it in `requested` and never brings it back.
const LAND = { shape: 3, remote: 'unused', trunk: 'refs/heads/main', expect: 'a'.repeat(40), items: [{ id: 9180, commit: 'b'.repeat(40) }], requested: ['shardProof'] };

/** One land job on a real board's lease rows behind a fetch stand-in that answers the queue as the board does; the claim carries `payload`. */
function boardBehindFetch(t, payload) {
  const db = cellBoard(t, ':memory:').db;
  const board = { db, attempt: 0 };
  createJob(db, { id: JOB, kind: 'land', now: Date.now() });
  board.claim = (runner, now = Date.now()) => {
    if (!takeJob(db, JOB, runner, { now }).taken) return null;
    board.attempt += 1;
    writeStep(db, JOB, 'claimed', { runner }, { seq: board.attempt, now });
    return { job: JOB, kind: 'land', needs: [], run: [], payload, candidate: null, base: null, attempt: board.attempt, token: `${runner}:${board.attempt}` };
  };
  board.fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    let reply = { recorded: true };
    if (call.action === 'claim') { const claim = board.claim(call.runner); reply = { claim, ...(claim ? { trunk: 'unused' } : {}) }; }
    else if (call.action === 'request') reply = { request: { land: {} } };
    else if (call.action === 'renew') reply = { renewed: renewLease(db, JOB, call.runner, { now: Date.now(), lapsed: true }) };
    else if (call.action === 'release') reply = backOffLease(db, JOB, call.runner, { attempt: board.attempt, reason: call.reason, now: Date.now() });
    return { status: 200, json: async () => reply };
  };
  return board;
}

/** Serve one claim with a land handler stand-in, and the setting as given. */
async function serve(t, board, handBackUnrunnable) {
  const { root } = privateFixtureFiles('pullboard-landback-cache-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The stand-in land handler would start the job; with the setting on, the runner never reaches it for this request.
  const handlers = { land: async () => ({ outcome: 'started' }) };
  return serveRunner({ git: pullGit, board: BOARD, runner: 'mill', capabilities: [], cache: root, once: true, fetchImpl: board.fetchImpl, handlers, trunkPack: async () => {}, handBackUnrunnable });
}

test('runners.land-handback-reason.with-jobs-handbackunrunnable-on-a-runner: clause 1: with jobs.handBackUnrunnable on, a runner given a land job whose shardProof run is missing releases it before any fetch, in the claim call, with a LAND_UNRUNNABLE reason [test] [C7,#9249]', async t => {
  const board = boardBehindFetch(t, LAND);
  const served = await serve(t, board, true);
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome]), [[JOB, 'released']]);
  const released = jobView(board.db, JOB).steps.find(step => step.name === 'released');
  assert.match(released.payload.reason, /\[LAND_UNRUNNABLE\].*shardProof was moved to the job request/u);
});

test('runners.land-handback-reason.the-reason-is-in-the-job: clause 2: the reason is in the job\'s steps and a second runner does not receive the job until the backoff passes [test] [C7,#9249]', async t => {
  const board = boardBehindFetch(t, LAND);
  await serve(t, board, true);
  const released = jobView(board.db, JOB).steps.find(step => step.name === 'released');
  assert.equal(released.payload.runner, 'mill');
  assert.equal(board.claim('anvil', released.at + 1_000), null, 'not handed to a second runner at once');
  assert.equal(board.claim('anvil', released.at + 30_001)?.attempt, 2, 'offered again once the backoff passed');
});

test('runners.land-handback-reason.with-jobs-handbackunrunnable-off-the-default: clause 1: with jobs.handBackUnrunnable off (the default) the same land job is started as before and no unrunnable reason is recorded [test] [C7,#9249]', async t => {
  const board = boardBehindFetch(t, LAND);
  await serve(t, board, false);
  const released = jobView(board.db, JOB).steps.find(step => step.name === 'released');
  assert.doesNotMatch(String(released?.payload.reason ?? ''), /LAND_UNRUNNABLE/u);
});
