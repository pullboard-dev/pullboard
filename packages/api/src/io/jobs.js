/** The board's runner job queue, served by the board API and kept out of the runner worker's import graph: offer a job with the capabilities it needs, claim by capability, renew, release, post a receipt [P7]. */
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { atomically } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';

/** A runner id or a capability: a plain name, so it reads the same in a log, a URL and SQL. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u;
// Budget: a receipt is a small record (status, digests, receipt ids); output belongs in a report file, not the row.
const RECEIPT_BYTES = 64 * 1024;
// Budget: a queue scan reads at most this many open rows per claim, so one claim stays a small read on any board.
const SCAN_ROWS = 500;
// Budget: a run is one short argv (a command and its test files), never a script body.
const RUN_ARGS = 256;
const RUN_ARG_BYTES = 4096;
// Budget: a job's request (a gate's pinned commits, config and trusted entries) stays inline, under the 64 KiB blob threshold the claim scan reads.
const REQUEST_BYTES = 60 * 1024;

/** The sha256 hex of a lease token: the board keeps only this, so its rows never hold a usable token. */
function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Refuse a list that is not plain names; return it sorted and without repeats. */
function names(list, what) {
  if (!Array.isArray(list) || list.some(name => typeof name !== 'string' || !NAME.test(name))) {
    throw new Refused('JOB_CAPABILITY', `${what} is a list of plain names (letters, digits, colon, dot, dash, underscore); send it as a JSON array`);
  }
  return [...new Set(list)].sort();
}

/** Refuse a run that is not a short argv of plain strings; return it, or an empty list for a job with none. */
function runArgv(run) {
  if (!Array.isArray(run) || run.length > RUN_ARGS || run.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > RUN_ARG_BYTES)) {
    throw new Refused('JOB_RUN', `a job's run is a command and its arguments as a JSON array of at most ${RUN_ARGS} strings; offer { run: ["node", "check.js"] }`);
  }
  return run;
}

/** Refuse a runner id that is not a plain name. */
function runnerId(runner) {
  if (typeof runner !== 'string' || !NAME.test(runner)) throw new Refused('JOB_RUNNER', 'a runner id is a plain name of letters, digits, colon, dot, dash or underscore; pass { runner }');
  return runner;
}

/**
 * Put a job on the queue with the capabilities a runner needs to take it. Offering an id that exists returns it as it
 * stands, so a retried offer never resets a job a runner already holds.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * The run is the argv a runner executes at the candidate commit [P7]. A request is the job's own input, read back by the
 * runner holding it with jobRequest: for a gate, the argv to run and the data it reads on stdin [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, kind: string, needs?: string[], run?: string[], item?: number | null, candidate?: string | null, base?: string | null, request?: Record<string, unknown> | null, now?: number }} fields
 * @returns {ReturnType<typeof jobView>}
 */
export function offerJob(db, { id, kind, needs = [], run = [], item = null, candidate = null, base = null, request = null, now = Date.now() }) {
  const wanted = names(needs, 'needs');
  const argv = runArgv(run);
  if (request !== null && (typeof request !== 'object' || Array.isArray(request) || Buffer.byteLength(JSON.stringify(request)) > REQUEST_BYTES)) {
    throw new Refused('JOB_REQUEST', `a job request is a JSON object of at most ${REQUEST_BYTES} bytes; keep large inputs in git and name them`);
  }
  return atomically(db, () => {
    const job = createJob(db, { id, kind, item, candidate, base, now });
    if (job.step === 'queued' && job.steps.length === 0) writeStep(db, id, 'offered', { needs: wanted, ...(argv.length ? { run: argv } : {}), ...(request ? { request } : {}) }, { now });
    return jobView(db, id);
  });
}

/**
 * The job of a kind offered for one item's candidate that has not finished, or null: a retried offer reuses it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kind: string, item: number, candidate: string }} fields
 * @returns {ReturnType<typeof jobView> | null}
 */
export function openJob(db, { kind, item, candidate }) {
  const row = db.prepare(`SELECT job.job_id FROM job JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_kind = ? AND job.job_item = ? AND job.job_candidate = ? AND job.job_step <> 'done' ORDER BY job.job_created DESC LIMIT 1`).get(kind, item, candidate);
  return row ? jobView(db, row.job_id) : null;
}

/**
 * Give the oldest open job this runner can run to it, by lease: a job is open while it is offered or its last claim's
 * lease has lapsed, and the runner can run it when it has every capability the job needs. The take is one guarded
 * UPDATE, so of two claimants only one wins; a lapsed lease needs no sweeper, since the next claim simply takes it.
 *
 * Why: a job is a row, not a process. Nothing on the board host waits on a runner; a dead runner only lets its lease
 * lapse, and the token the claim returns is what authenticates that runner's renewals and receipt.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ runner: string, capabilities?: string[], kinds?: string[] | null, now?: number, leaseMs?: number }} request
 * @returns {{ job: string, kind: string, needs: string[], run: string[], item: number | null, candidate: string | null, base: string | null, attempt: number, leaseUntil: number, token: string } | null}
 *   null when no open job matches. The candidate and run tell a runner what to fetch and execute [P7].
 */
export function claimJob(db, { runner, capabilities = [], kinds = null, now = Date.now(), leaseMs = LEASE_MS }) {
  runnerId(runner);
  const has = new Set(names(capabilities, 'capabilities'));
  const only = kinds === null ? null : new Set(names(kinds, 'kinds'));
  return atomically(db, () => {
    const open = db.prepare(`SELECT job.job_id, job.job_kind, job.job_item, job.job_candidate, job.job_base, step.job_step_payload FROM job JOIN job_step AS step
      ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
      WHERE job.job_step IN ('offered', 'claimed') AND job.job_lease_until < ? ORDER BY job.job_created, job.job_id LIMIT ?`).all(now, SCAN_ROWS);
    for (const row of open) {
      const { needs = [], run = [] } = JSON.parse(row.job_step_payload);
      if (only && !only.has(row.job_kind)) continue;
      if (!needs.every(need => has.has(need))) continue;
      const taken = db.prepare("UPDATE job SET job_lease_owner = ?, job_lease_until = ?, job_attempt = job_attempt + 1, job_updated = ? WHERE job_id = ? AND job_lease_until < ? AND job_step IN ('offered', 'claimed')")
        .run(runner, now + leaseMs, now, row.job_id, now);
      if (taken.changes !== 1) continue;
      const { job_attempt: attempt } = db.prepare('SELECT job_attempt FROM job WHERE job_id = ?').get(row.job_id);
      const token = randomBytes(24).toString('base64url');
      writeStep(db, row.job_id, 'claimed', { runner, capabilities: [...has], token: tokenHash(token) }, { seq: attempt, now });
      return { job: row.job_id, kind: row.job_kind, needs, run, item: row.job_item, candidate: row.job_candidate, base: row.job_base, attempt, leaseUntil: now + leaseMs, token };
    }
    return null;
  });
}

/**
 * The job and attempt a runner's token holds, or a refusal naming why it holds nothing: the token must be the one
 * the job's current claim returned, to this runner.
 */
function heldBy(db, job, runner, token) {
  runnerId(runner);
  const row = db.prepare('SELECT job_attempt, job_step FROM job WHERE job_id = ?').get(String(job ?? ''));
  if (!row) throw new Refused('JOB_MISSING', `no job ${job} on this board; claim a job first`);
  const claim = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'claimed' AND job_step_seq = ?").get(job, row.job_attempt);
  const stored = claim ? JSON.parse(claim.job_step_payload) : null;
  const want = Buffer.from(stored?.token ?? ''), got = Buffer.from(tokenHash(token ?? ''));
  if (!stored || stored.runner !== runner || want.length !== got.length || !timingSafeEqual(want, got)) {
    throw new Refused('JOB_LEASE_MOVED', `runner ${runner} does not hold job ${job}'s current claim; stop work on it and claim a new job`);
  }
  return { attempt: row.job_attempt, step: row.job_step };
}

/**
 * Extend the lease of the runner holding a job's current claim. False once the lease lapsed: the job may already be
 * another runner's, so the caller stops.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, now?: number, leaseMs?: number }} request
 * @returns {{ renewed: boolean, leaseUntil: number | null }}
 */
export function renewJob(db, { job, runner, token, now = Date.now(), leaseMs = LEASE_MS }) {
  heldBy(db, job, runner, token);
  const renewed = renewLease(db, job, runner, { now, leaseMs });
  return { renewed, leaseUntil: renewed ? now + leaseMs : null };
}

/**
 * The input of a job, for the runner holding its current claim only: its candidate, base and the request it was offered with.
 * Why a separate call: the claim stays one small scan, and only the winner reads the request.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string }} request
 * @returns {{ job: string, kind: string, item: number | null, candidate: string | null, base: string | null, request: Record<string, unknown> | null }}
 */
export function jobRequest(db, { job, runner, token }) {
  heldBy(db, job, runner, token);
  const row = db.prepare(`SELECT job.job_kind, job.job_item, job.job_candidate, job.job_base, step.job_step_payload FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0 WHERE job.job_id = ?`).get(job);
  return { job, kind: row.job_kind, item: row.job_item, candidate: row.job_candidate, base: row.job_base, request: JSON.parse(row.job_step_payload).request ?? null };
}

/**
 * Hand a job back to the queue at once, before its lease would lapse: a runner that cannot finish it frees it now.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, now?: number }} request
 * @returns {{ released: boolean }}
 */
export function releaseJob(db, { job, runner, token, now = Date.now() }) {
  heldBy(db, job, runner, token);
  return { released: releaseLease(db, job, runner, { now }) };
}

/**
 * Record the receipt for a job's current claim under that job and mark it done. Only the runner whose token the
 * current claim returned may post; a runner whose lease lapsed may still post while no other runner has claimed the
 * job since. Posting the same attempt's receipt again returns the stored one.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, receipt: Record<string, unknown>, now?: number }} request
 * @returns {{ job: string, attempt: number, receipt: Record<string, unknown>, recorded: boolean }}
 */
export function postReceipt(db, { job, runner, token, receipt, now = Date.now() }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Refused('JOB_RECEIPT', 'a receipt is a JSON object; post { receipt: { ... } }');
  if (Buffer.byteLength(JSON.stringify(receipt)) > RECEIPT_BYTES) throw new Refused('JOB_RECEIPT', `a receipt is at most ${RECEIPT_BYTES} bytes; keep output in a report file and post its digest`);
  return atomically(db, () => {
    const { attempt } = heldBy(db, job, runner, token);
    const written = writeStep(db, job, 'receipt', { runner, attempt, receipt }, { seq: attempt, now });
    finishJob(db, job, runner, { now });
    return { job, attempt, receipt: written.payload.receipt, recorded: written.written };
  });
}

/**
 * Answer one queue call as the board API carries it: `{ action: 'claim' | 'request' | 'renew' | 'release' | 'receipt', ... }`.
 * The queue answers only while the machine runs runner jobs by pull, so today's path never sees it. A claim also names
 * the board's trunk remote, the one place a runner fetches the candidate from, kept apart from the board host [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} body
 * @param {{ mode: string, now?: number, trunk?: () => string | null }} options - mode is the machine's gate.runnerDispatch.
 * @returns {object}
 */
export function jobQueueCall(db, body, { mode, now = Date.now(), trunk = () => null }) {
  if (mode !== 'pull') throw new Refused('JOBS_NOT_PULL', 'this board serves its runner job queue only when gate.runnerDispatch is pull; set it with pullboard settings');
  const { action, runner, capabilities, kinds, job, token, receipt } = body ?? {};
  if (action === 'claim') {
    const claim = claimJob(db, { runner, capabilities, kinds: kinds ?? null, now });
    return { claim, ...(claim ? { trunk: trunk() } : {}) };
  }
  if (action === 'request') return jobRequest(db, { job, runner, token });
  if (action === 'renew') return renewJob(db, { job, runner, token, now });
  if (action === 'release') return releaseJob(db, { job, runner, token, now });
  if (action === 'receipt') return postReceipt(db, { job, runner, token, receipt, now });
  throw new Refused('JOB_ACTION', 'a job queue call names its action: claim, request, renew, release or receipt');
}
