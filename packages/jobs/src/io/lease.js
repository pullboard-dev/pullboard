/** Take, renew and reclaim job leases on the board's SQLite handle [C7]. */
import { Refused } from "../../../kernel/light.js";
import { LEASE_MS } from "../logic/rules.js";
import { atomically } from "./store.js";
import { jobView } from "./store.js";
import { noteLease } from "./store.js";
import { writeStep } from "./store.js";

/**
 * Take a job for a driver. Succeeds only in one statement where the lease has lapsed, so two drivers never both win.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} owner - The driver id.
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {{taken: boolean, job: ReturnType<typeof jobView>}} taken is false when another driver holds a live lease.
 */
export function takeJob(db, job, owner, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
  if (!owner) throw new Refused('JOB_OWNER', 'A lease needs an owner: pass the driver id.');
  const result = db.prepare('UPDATE job SET job_lease_owner = ?, job_lease_until = ?, job_updated = ? WHERE job_id = ? AND job_lease_until < ?')
    .run(owner, now + leaseMs, now, job, now);
  if (result.changes === 1) noteLease(db, job, 'lease.grant', { owner, until: now + leaseMs }, now);
  const view = jobView(db, job);
  if (!view) throw new Refused('JOB_MISSING', `No job ${job}: create it with createJob first.`);
  return { taken: result.changes === 1, job: view };
}

/**
 * Extend the lease of the driver that holds it: one UPDATE, no history read. A driver whose lease moved gets false.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} owner
 * @param {{now?: number, leaseMs?: number, lapsed?: boolean}} [options] - lapsed: also renew a lapsed lease the owner
 *   still holds, for a caller that proved no one took the job since (a runner's current-claim token, #6546).
 * @returns {boolean} True when the lease was renewed.
 */
export function renewLease(db, job, owner, { now = Date.now(), leaseMs = LEASE_MS, lapsed = false } = {}) {
  const renewed = db.prepare('UPDATE job SET job_lease_until = ? WHERE job_id = ? AND job_lease_owner = ? AND job_lease_until >= ?')
    .run(now + leaseMs, job, owner, lapsed ? 0 : now).changes === 1;
  if (renewed) noteLease(db, job, 'lease.renew', { owner, until: now + leaseMs }, now);
  return renewed;
}

/**
 * Hand a job back with a recorded reason, not claimable again until a backoff that grows with its attempt has passed.
 *
 * Why: a runner whose handler threw released its job at once, and another runner re-claimed it 60 ms later, forever:
 * one land job took 122,801 claims in 3.5 hours (#6545, #6546). The release step keeps the job's current step, so views
 * still read it as claimed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} owner
 * @param {{attempt: number, reason?: string, now?: number}} release - attempt: the claim being released, from 1.
 * @returns {{released: boolean, until: number}} until: when claim may take the job again.
 */
export function backOffLease(db, job, owner, { attempt, reason = 'unspecified', now = Date.now() }) {
  const until = now + releaseBackoffMs(attempt);
  return atomically(db, () => {
    const held = db.prepare('SELECT job_step FROM job WHERE job_id = ? AND job_lease_owner = ?').get(job, owner);
    if (!held) return { released: false, until };
    // The note goes first so the `released` step stays the job's last row, as its readers expect.
    noteLease(db, job, 'lease.release', { owner, reason: String(reason).slice(0, 300), until }, now);
    writeStep(db, job, 'released', { runner: owner, attempt, reason: String(reason).slice(0, 300), until }, { seq: attempt, now });
    db.prepare('UPDATE job SET job_step = ?, job_lease_owner = NULL, job_lease_until = ?, job_updated = ? WHERE job_id = ?').run(held.job_step, until, now, job);
    return { released: true, until };
  });
}

/** The wait before a job released on attempt n is offered again: 30 s, doubling per attempt, capped at 5 minutes. */
export function releaseBackoffMs(attempt) {
  return Math.min(RELEASE_BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 20) - 1), RELEASE_BACKOFF_MAX_MS);
}
// Budget: a released job waits at least 30 s, so a failing handler costs one claim a half-minute, not ten a second.
const RELEASE_BACKOFF_FIRST_MS = 30_000;
// Budget: the backoff stops growing at 5 minutes, so a recovered runner takes the job without a person.
const RELEASE_BACKOFF_MAX_MS = 300_000;

/**
 * Jobs that were taken and whose lease has lapsed (lease_until < now), oldest first. A lease runs 2 minutes from the last
 * renewal, so a silent driver's job is reclaimable 2 minutes after that renewal.
 *
 * Why: a job never taken has no owner and is simply queued; only a taken job that went silent is stalled.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, leaseMs?: number}} [options]
 * @returns {{id: string, kind: string, step: string, leaseOwner: string, lapsedMs: number}[]}
 */
export function reclaimLapsed(db, { now = Date.now() } = {}) {
  return db.prepare('SELECT job_id, job_kind, job_step, job_lease_owner, job_lease_until FROM job WHERE job_lease_owner IS NOT NULL AND job_lease_until < ? ORDER BY job_lease_until')
    .all(now)
    .map(row => ({ id: row.job_id, kind: row.job_kind, step: row.job_step, leaseOwner: row.job_lease_owner, lapsedMs: now - row.job_lease_until }));
}

/**
 * Give up a lease the driver holds, clearing its owner so the job reads as nobody's and is never listed as lapsed.
 *
 * Why: a driver that wrote a terminal step is done with the job; freeing the lease at once frees the worker instead of
 * leaving a lease that lapses 2 minutes later and reads as a stalled job.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} owner
 * @param {{now?: number}} [options]
 * @returns {boolean} True when this owner held the lease and it is now free.
 */
export function releaseLease(db, job, owner, { now = Date.now() } = {}) {
  const released = db.prepare('UPDATE job SET job_lease_owner = NULL, job_lease_until = 0, job_updated = ? WHERE job_id = ? AND job_lease_owner = ?')
    .run(now, job, owner).changes === 1;
  if (released) noteLease(db, job, 'lease.release', { owner }, now);
  return released;
}

/**
 * End a job the driver finished: mark it `done` and release the lease the driver holds, in one UPDATE.
 *
 * Why: a landing that wrote its publish step still held a lease that lapsed, so status and show read it as a stalled
 * landing though it merged. `done` is a terminal mark on the row, not a step, so the step log stays the work done.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} owner - The driver that holds the lease, live or lapsed.
 * @param {{now?: number}} [options]
 * @returns {boolean} True when the job is now done; false when another driver holds the lease.
 */
export function finishJob(db, job, owner, { now = Date.now() } = {}) {
  const finished = db.prepare("UPDATE job SET job_step = 'done', job_lease_owner = NULL, job_lease_until = 0, job_updated = ? WHERE job_id = ? AND (job_lease_owner = ? OR job_lease_owner IS NULL OR job_lease_until < ?)")
    .run(now, job, owner, now).changes === 1;
  if (finished) noteLease(db, job, 'end.finished', { owner }, now);
  return finished;
}

/**
 * Set a job row's step, attempt, owner and lease to what the job move table decided [C7,#8387].
 * Why here: the table answers with the whole row, and this file is the one writer of those columns, so the api's live writer hands the answer to it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ step: string, attempt: number, owner?: string | null, leaseUntil?: number | null }} row
 * @param {{now?: number}} [options]
 */
export function setJobRow(db, job, { step, attempt, owner = null, leaseUntil = null }, { now = Date.now() } = {}) {
  db.prepare('UPDATE job SET job_step = ?, job_attempt = ?, job_lease_owner = ?, job_lease_until = ?, job_updated = ? WHERE job_id = ?')
    .run(step, attempt, owner, leaseUntil, now, String(job));
}

/**
 * Keep an unowned job from every claim until `until`: claim takes only a job whose lease_until has passed.
 * Why: a land job offered again after trunk-busy waits a backoff, so trunk can settle before it tries again (#9102).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {number} until
 * @param {{now?: number}} [options]
 * @returns {boolean} True when the unowned job now waits until `until`.
 */
export function holdJob(db, job, until, { now = Date.now() } = {}) {
  return db.prepare('UPDATE job SET job_lease_until = ?, job_updated = ? WHERE job_id = ? AND job_lease_owner IS NULL').run(until, now, String(job)).changes === 1;
}

/**
 * Point a queued job at the commit it runs at, as its candidate and base, before it is offered to runners.
 *
 * Why: a main-test job is queued by main's tree id, which a runner cannot check out; the board names the main commit
 * holding that tree when it offers the job (#6063). Only a queued row moves, so a claimed job never changes commit.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} commit
 * @param {{now?: number}} [options]
 * @returns {boolean} True when the queued job now names the commit.
 */
export function pinQueuedJob(db, job, commit, { now = Date.now() } = {}) {
  return db.prepare("UPDATE job SET job_candidate = ?, job_base = ?, job_updated = ? WHERE job_id = ? AND job_step = 'queued'").run(commit, commit, now, job).changes === 1;
}

/**
 * Mark a job's receipt as applied by the board: the runs file's inbox mark. Only the first mark lands, so a repeated
 * ack changes nothing.
 *
 * Why: the board applies a receipt in its own move, then acks it here; the reconciler re-applies any job whose receipt
 * is still unmarked, so the mark must be written once and only after the board committed (runner-store split, S5).
 * The job_applied column exists only in the runs file.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The runs file.
 * @param {string} job
 * @param {{now?: number}} [options]
 * @returns {boolean} True when this call set the mark.
 */
export function markApplied(db, job, { now = Date.now() } = {}) {
  return db.prepare('UPDATE job SET job_applied = ?, job_updated = ? WHERE job_id = ? AND job_applied IS NULL').run(now, now, job).changes === 1;
}
/**
 * End a job that has not finished, whoever holds its lease: a step naming why, then done. False when it is gone or already done.
 * Why: a withdrawn or abandoned job must stop even while a runner holds a live lease; that runner's next renewal then finds it done.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} name - The step that says why it ended, such as `withdrawn` or `abandoned`.
 * @param {Record<string, unknown>} [payload]
 * @param {{now?: number}} [options]
 * @returns {boolean}
 */
export function endJob(db, job, name, payload = {}, { now = Date.now() } = {}) {
  return atomically(db, () => {
    const row = db.prepare('SELECT job_attempt, job_step FROM job WHERE job_id = ?').get(job);
    if (!row || row.job_step === 'done') return false;
    writeStep(db, job, name, payload, { seq: row.job_attempt, now });
    db.prepare("UPDATE job SET job_step = 'done', job_lease_owner = NULL, job_lease_until = 0, job_updated = ? WHERE job_id = ?").run(now, job);
    noteLease(db, job, `end.${name}`, { detail: String(payload.detail ?? '').slice(0, 300) }, now);
    return true;
  });
}

