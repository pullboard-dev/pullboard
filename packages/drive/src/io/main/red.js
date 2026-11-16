/**
 * Main-red lookup for the gate [C7]: read main's receipt for a test file, and when it is missing enqueue a
 * main-test job (a row any driver resumes) rather than running a refresh process. Nothing here runs a test.
 */
import { createJob } from '../../../../jobs/index.js';
import { jobsOf } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { classifyMainRed } from '../../../../receipt/index.js';
import { mainRedStatus } from '../../../../receipt/index.js';
import { MAIN_TEST_JOB } from '../../../../receipt/index.js';
import { mainTestJobId } from '../../../../receipt/index.js';

export { MAIN_TEST_JOB };

/**
 * Answer whether a file is red on main from its keyed receipt; on a miss, enqueue the main-test job that writes it.
 * Enqueueing is idempotent on the key, so many gates asking about one file at one tree make one job.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board, which the receipts read from.
 * @param {Iterable<object> | Map<string, object>} receipts - main-test receipts known to the board
 * @param {{ tree: string, file: string, command: string, now?: number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} at - runs: the board's runs holder while runs_store is on (boardRunsHolder); the job row goes there and not to `db`, which stays the board [P7,#9080].
 * @returns {ReturnType<typeof mainRedStatus> & { job: string | null }}
 */
export function mainRedLookup(db, receipts, { tree, file, command, now = Date.now(), runs = null }) {
  const status = mainRedStatus(receipts, { tree, file, command });
  if (status.status !== 'missing') return { ...status, job: null };
  const id = mainTestJobId(status.key);
  // The job row lives in the runs file while the flag is on, else on the board as before.
  const jobs = runs?.db ?? db;
  createJob(jobs, { id, kind: MAIN_TEST_JOB, base: tree, now });
  writeStep(jobs, id, 'queued', { tree, file, command }, { now });
  return { ...status, job: jobView(jobs, id).id };
}

/**
 * Classify a gate's reds in one file as main's own or the candidate's, from main's receipt; the receipt id goes in
 * the result so the gate result names its proof. A missing receipt enqueues the main-test job and stays unknown.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board, which the receipts read from.
 * @param {Iterable<object> | Map<string, object>} receipts
 * @param {{ tree: string, file: string, command: string, reds: string[], now?: number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} gate - runs: as for mainRedLookup.
 * @returns {ReturnType<typeof classifyMainRed> & { file: string, job: string | null }}
 */
export function classifyGateRed(db, receipts, { tree, file, command, reds, now = Date.now(), runs = null }) {
  const main = mainRedLookup(db, receipts, { tree, file, command, now, runs });
  return { file, ...classifyMainRed(reds, main), job: main.job };
}

/**
 * The ports the gate cell's main-owned verdict reaches the board through: the jobs cell's front door, and this cell's
 * idempotent main-test enqueue. Why: the gate cell judges and records its verdict, but it imports no board cell, so
 * every production caller (the submit gate and the dispatcher) hands it the same ports from here [C7,#3534].
 *
 * @returns {{ jobs: { createJob: typeof createJob, writeStep: typeof writeStep, jobView: typeof jobView, jobsOf: typeof jobsOf },
 *   mainTestKind: string, queueMainTest: (db: import('node:sqlite').DatabaseSync, at: { tree: string, file: string, command: string, now?: number }) => string }}
 */
export function mainOwnedVerdictPorts() {
  return { jobs: { createJob, writeStep, jobView, jobsOf }, mainTestKind: MAIN_TEST_JOB, queueMainTest: (db, at) => mainRedLookup(db, [], at).job };
}
