/** The dispatcher is a job row with a lease: ensure takes a lapsed row and spawns the loop (RFC 0008 DJ16) [C7]. */
import { Refused } from '../../../kernel/index.js';
import {
  createJob,
  takeJob,
  renewLease,
  writeStep,
  jobView,
} from '../../../jobs/index.js';

/** The one dispatcher row's job id. */
export const DISPATCHER_JOB = 'dispatcher';

/**
 * Ensure a dispatcher loop runs: take the dispatcher row if its lease lapsed and spawn the loop under that lease.
 * A live lease means a loop already runs, so nothing is spawned.
 *
 * Why: the row, not a parent process, decides who dispatches (#2873), so two loops never run, and a loop that wedges
 * stops renewing and is replaced by the next ensure once its 2-minute lease lapses (#2990). The spawned step is
 * written only after spawn returns, so a spawn that throws leaves the row to be retaken when its lease lapses.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{owner: string, spawn: (lease: {owner: string, job: string}) => unknown, now?: number, leaseMs?: number}} options
 *   owner is the new driver id; spawn starts the loop, which must call renewDispatcher with that owner.
 * @returns {{spawned: boolean, owner: string|null, replaced: string|null}} owner is the lease holder after the call;
 *   replaced names the lapsed holder this call took over from.
 */
export function ensureDispatcher(db, { owner, spawn, now = Date.now(), leaseMs } = /** @type {any} */ ({})) {
  if (typeof spawn !== 'function') throw new Refused('DISPATCHER_SPAWN', 'ensureDispatcher needs a spawn function that starts the loop: pass { spawn }.');
  createJob(db, { id: DISPATCHER_JOB, kind: 'dispatcher', now });
  const previous = jobView(db, DISPATCHER_JOB)?.leaseOwner ?? null;
  const take = takeJob(db, DISPATCHER_JOB, owner, { now, leaseMs });
  if (!take.taken) return { spawned: false, owner: take.job.leaseOwner, replaced: null };
  const spawnedBefore = take.job.steps.filter(step => step.name === 'dispatcher.spawned').length;
  spawn({ owner, job: DISPATCHER_JOB });
  writeStep(db, DISPATCHER_JOB, 'dispatcher.spawned', { owner, replaced: previous }, { seq: spawnedBefore, now });
  return { spawned: true, owner, replaced: previous };
}

/**
 * Renew the dispatcher lease from inside the loop. False means the lease lapsed and another loop took the row, so
 * this loop must stop.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} owner
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {boolean}
 */
export function renewDispatcher(db, owner, options = {}) {
  return renewLease(db, DISPATCHER_JOB, owner, options);
}
