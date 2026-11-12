/** Review reservations as job leases: reserve, renew, reclaim on the 2-minute rule [C7]. */
import { Refused } from "../../../kernel/light.js";
import { LEASE_MS } from "../logic/rules.js";
import { createJob } from "./store.js";
import { writeStep } from "./store.js";
import { jobView } from "./store.js";
import { atomically } from "./store.js";
import { takeJob } from "./lease.js";
import { renewLease } from "./lease.js";
import { finishJob } from "./lease.js";

/**
 * The job id that carries an item's review reservation.
 *
 * @param {number} item
 * @returns {string}
 */
export function reviewJobId(item) {
  if (!Number.isInteger(item) || item < 1) throw new Refused('REVIEW_ITEM', 'A review reservation needs an item number: pass the item id.');
  return `review:${item}`;
}

/**
 * Reserve an item's review for a reviewer: a lease on the item's review job. Fails while another reviewer's lease is live.
 *
 * Why: a reservation held by a process that died used to keep an item "in review" for hours; as a lease it frees itself.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @param {string} reviewer
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {{reserved: boolean, holder: string|null}}
 */
export function reserveReview(db, item, reviewer, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
  if (!reviewer) throw new Refused('REVIEW_RESERVER', 'A review reservation needs a reviewer: pass the agent id.');
  const id = reviewJobId(item);
  createJob(db, { id, kind: 'review', item, now });
  const { taken, job } = takeJob(db, id, reviewer, { now, leaseMs });
  if (taken) writeStep(db, id, 'reserved', { reviewer }, { seq: job.attempt, now });
  return { reserved: taken, holder: taken ? reviewer : job.leaseOwner };
}

/**
 * Renew a reviewer's reservation: the reviewer's heartbeat. False when the lease lapsed or moved to another reviewer.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @param {string} reviewer
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {boolean}
 */
export function renewReview(db, item, reviewer, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
  return renewLease(db, reviewJobId(item), reviewer, { now, leaseMs });
}

/**
 * Reclaim every review reservation whose lease lapsed: record a `lapsed` step naming the silent reviewer and clear the
 * holder, so the item is offered again. A reservation renewed in the meantime is left alone.
 *
 * Why `seen`: a reviewer's heartbeat lives off the board, so the board reads it here. A reviewer seen within the lease
 * window is not silent: its lease is extended to that sighting plus the window instead of being reclaimed, but only
 * while `submitted` says its item still awaits review (SM5): a heartbeat never keeps a review whose item moved on.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, leaseMs?: number, seen?: (reviewer: string) => number|null, submitted?: (item: number) => boolean}} [options] -
 *   seen: the reviewer's last heartbeat in epoch milliseconds, or null when unknown; submitted: whether the item is
 *   submitted now.
 * @returns {{item: number, reviewer: string, lapsedMs: number}[]} The reservations reclaimed by this pass.
 */
export function reclaimLapsedReviews(db, { now = Date.now(), leaseMs = LEASE_MS, seen = () => null, submitted = () => true } = {}) {
  const rows = db.prepare("SELECT job_id, job_item, job_attempt, job_lease_owner, job_lease_until FROM job WHERE job_kind = 'review' AND job_lease_owner IS NOT NULL AND job_lease_until < ? ORDER BY job_lease_until").all(now);
  const reclaimed = [];
  for (const row of rows) {
    const sighting = seen(row.job_lease_owner);
    if (Number.isFinite(sighting) && sighting <= now && sighting + leaseMs >= now && submitted(row.job_item) === true) {
      db.prepare('UPDATE job SET job_lease_until = ? WHERE job_id = ? AND job_lease_owner = ?').run(sighting + leaseMs, row.job_id, row.job_lease_owner);
      continue;
    }
    const cleared = db.prepare('UPDATE job SET job_lease_owner = NULL, job_attempt = job_attempt + 1, job_updated = ? WHERE job_id = ? AND job_lease_owner = ? AND job_lease_until < ?')
      .run(now, row.job_id, row.job_lease_owner, now);
    if (cleared.changes !== 1) continue;
    const lapse = { item: row.job_item, reviewer: row.job_lease_owner, lapsedMs: now - row.job_lease_until };
    writeStep(db, row.job_id, 'lapsed', lapse, { seq: row.job_attempt, now });
    reclaimed.push(lapse);
  }
  return reclaimed;
}

/**
 * End an item's review lease whoever holds it, recording a `released` step: the review ended by a verdict, a release
 * or a hand-over the board already allowed. A review with no live holder records nothing.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @param {{now?: number}} [options]
 * @returns {string|null} The reviewer whose lease ended, or null.
 */
export function releaseReview(db, item, { now = Date.now() } = {}) {
  const job = jobView(db, reviewJobId(item));
  if (!job?.leaseOwner) return null;
  db.prepare('UPDATE job SET job_lease_owner = NULL, job_lease_until = 0, job_attempt = job_attempt + 1, job_updated = ? WHERE job_id = ?').run(now, job.id);
  writeStep(db, job.id, 'released', { reviewer: job.leaseOwner }, { seq: job.attempt, now });
  return job.leaseOwner;
}

/**
 * End an item's review job because its item left review (a verdict, a withdrawal or a reopen): release a live holder
 * with a `released` step, then mark the job `done`. A job that is missing or already done is left alone.
 *
 * Why: the job used to outlive its item's review, so a heartbeating reviewer kept a lease on an item already verified,
 * withdrawn or reopened (SM5). Run inside the board move's transaction so the item and its job move together.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @param {{now?: number}} [options]
 * @returns {string|null} The reviewer whose lease ended, or null.
 */
export function endReview(db, item, { now = Date.now() } = {}) {
  const id = reviewJobId(item);
  return atomically(db, () => {
    const job = jobView(db, id);
    if (!job || job.step === 'done') return null;
    const reviewer = releaseReview(db, item, { now });
    finishJob(db, id, reviewer ?? 'review', { now });
    return reviewer;
  });
}

/**
 * Who holds an item's review at `now`: the live reviewer, or null when the item is open for review.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @param {{now?: number}} [options]
 * @returns {{offered: boolean, holder: string|null, lapses: {reviewer: string, lapsedMs: number, at: number}[]}}
 */
export function reviewOffer(db, item, { now = Date.now() } = {}) {
  const job = jobView(db, reviewJobId(item));
  if (!job) return { offered: true, holder: null, lapses: [] };
  const live = job.leaseOwner !== null && job.leaseUntil >= now;
  const lapses = job.steps.filter(step => step.name === 'lapsed').map(step => ({ reviewer: step.payload.reviewer, lapsedMs: step.payload.lapsedMs, at: step.at }));
  return { offered: !live, holder: live ? job.leaseOwner : null, lapses };
}
