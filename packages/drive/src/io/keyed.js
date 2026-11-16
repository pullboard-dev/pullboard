/** Derived results as content-keyed jobs: read the stored result, or take the job and produce it, or wait on its lease [C7]. */
import { setTimeout as pause } from 'node:timers/promises';
import { Refused } from '../../../kernel/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { treeOf } from '../../../pin/index.js';
import { attemptsOf } from '../logic/keyed.js';
import { CELLS_INVENTORY_KIND } from '../logic/keyed.js';
import { keyedJobId } from '../logic/keyed.js';
import { PART_PREFIX } from '../logic/keyed.js';
import { RESULT_STEP } from '../logic/keyed.js';
import { savedParts } from '../logic/keyed.js';
import { STARTED_STEP } from '../logic/keyed.js';
import { storedResult } from '../logic/keyed.js';

/** How often a producing driver renews its lease (RFC 0008 DJ13). */
const RENEW_MS = 5_000;

/** How often a waiting gate looks at the job again. */
const POLL_MS = 1_000;

/**
 * Produce the result under this driver's lease, renewing it while produce runs, then write the result step.
 *
 * Why: produce may take minutes, so the lease is renewed on a timer; saved parts are steps on the row, so a driver
 * killed mid-run loses none of them, and the next driver's produce receives them in `saved`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view - The job, taken by this driver.
 * @param {{ key: string, owner: string, produce: Function, now: () => number, renewMs: number }} options
 * @returns {Promise<{ result: any, owner: string | null }>} The stored result, which is the first one written.
 */
async function produceUnderLease(db, view, { key, owner, produce, now, renewMs }) {
  const attempt = attemptsOf(view);
  writeStep(db, view.id, STARTED_STEP, { owner, attempt }, { seq: attempt, now: now() });
  const heartbeat = setInterval(() => { renewLease(db, view.id, owner, { now: now() }); }, renewMs);
  heartbeat.unref?.();
  let result;
  try {
    result = await produce({
      key,
      job: view.id,
      owner,
      saved: savedParts(view),
      save: (name, payload) => writeStep(db, view.id, `${PART_PREFIX}${name}`, payload, { now: now() }).payload,
    });
  } catch (error) {
    // A producer that fails frees the job now, so the next driver resumes it instead of waiting out the lease (#3529).
    releaseLease(db, view.id, owner, { now: now() });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
  // Results are facts: a driver whose lease moved still writes, and the unique step key keeps the first result.
  const stored = writeStep(db, view.id, RESULT_STEP, { result: result ?? null, owner }, { now: now() }).payload;
  return { result: stored.result, owner: stored.owner ?? null };
}

/**
 * Get a derived result keyed by content: read it when stored; else create the job (idempotent), take its lease and
 * produce it; else, while another driver holds a live lease, wait on that lease until the result is written or the
 * lease lapses and this driver takes over. Gives up after `waitMs` with state `pending`, never failing the caller.
 *
 * Why: no process is load-bearing (RFC 0008 DJ21). The job row, not a background producer, holds who produces and
 * what was produced, so whichever driver needs the result first computes it once and every later caller reuses it.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ kind: string, key: string, owner: string,
 *   produce: (job: { key: string, job: string, owner: string, saved: Map<string, any>, save: (name: string, payload: any) => any }) => any,
 *   now?: () => number, sleep?: (ms: number) => Promise<unknown>, waitMs?: number, pollMs?: number, renewMs?: number,
 *   runs?: { db: import('node:sqlite').DatabaseSync } | null }} options - runs: the board's runs holder while runs_store is on (boardRunsHolder); the job's rows go to its handle and not to `db` [P7,#9080].
 * @returns {Promise<{ state: 'stored' | 'produced' | 'pending', job: string, key: string, result?: any, owner?: string | null, holder?: string | null }>}
 */
export async function keyedResult(db, { kind, key, owner, produce, now = Date.now, sleep = pause, waitMs = LEASE_MS + RENEW_MS, pollMs = POLL_MS, renewMs = RENEW_MS, runs = null } = /** @type {any} */ ({})) {
  if (!kind || !key) throw new Refused('KEYED_RESULT_KEY', 'A keyed result needs a kind and a content key: pass { kind, key }.');
  if (!owner) throw new Refused('KEYED_RESULT_OWNER', 'A keyed result needs a driver id to hold the lease: pass { owner }.');
  if (typeof produce !== 'function') throw new Refused('KEYED_RESULT_PRODUCE', 'A keyed result needs a produce function for when none is stored: pass { produce }.');
  const id = keyedJobId(kind, key);
  const jobs = runs?.db ?? db;
  createJob(jobs, { id, kind, candidate: key, now: now() });
  const deadline = now() + waitMs;
  for (;;) {
    const stored = storedResult(jobView(jobs, id));
    if (stored) return { state: 'stored', job: id, key, ...stored };
    const take = takeJob(jobs, id, owner, { now: now() });
    if (take.taken) {
      const raced = storedResult(take.job);
      if (raced) return { state: 'stored', job: id, key, ...raced };
      return { state: 'produced', job: id, key, ...await produceUnderLease(jobs, take.job, { key, owner, produce, now, renewMs }) };
    }
    if (now() >= deadline) return { state: 'pending', job: id, key, holder: take.job.leaseOwner };
    await sleep(pollMs);
  }
}

/**
 * The cells inventory of a commit's tree as a keyed job of kind cells-inventory: the stored result when any driver
 * produced it for this tree, else produced here by `produce`, else waited for on the producing driver's lease.
 *
 * Why: keyed by the tree id, not the commit, so every gate whose base has the same tree reuses one inventory, and
 * nothing waits on a background producer racing main (CELLS_INVENTORY_PENDING, 6 Nov).
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ repo: string, commit: string, owner: string, produce: Function, now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>, waitMs?: number, pollMs?: number, renewMs?: number }} options
 *   produce receives { key: tree, job, owner, saved, save } and returns the inventory's small JSON descriptor.
 * @returns {ReturnType<typeof keyedResult>}
 */
export function cellsInventoryJob(db, { repo, commit, ...options } = /** @type {any} */ ({})) {
  if (!repo || !commit) throw new Refused('CELLS_INVENTORY_SOURCE', 'The cells inventory job needs a repository and a commit: pass { repo, commit }.');
  return keyedResult(db, { ...options, kind: CELLS_INVENTORY_KIND, key: treeOf(repo, commit) });
}
