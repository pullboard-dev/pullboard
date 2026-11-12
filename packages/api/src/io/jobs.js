/** The board's runner job queue, served by the board API and kept out of the runner worker's import graph: offer a job with the capabilities it needs, claim by capability, renew, release, post progress and a receipt [P7]. */
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
// Budget: a job's payload names its work (commits, refs, a sha); the code itself moves through git, never the board.
const PAYLOAD_BYTES = 16 * 1024;
// Budget: a job's request (a gate's pinned commits, config and trusted entries) stays inline, under the 64 KiB blob threshold the claim scan reads.
const REQUEST_BYTES = 60 * 1024;
// Budget: a progress step names each file once with a state word; it stays inline, under the 64 KiB blob threshold, so the live reader parses the row itself.
const PROGRESS_BYTES = 60 * 1024;
/** A repository-relative test path: never absolute, never climbing out, never a host or checkout folder. */
const RELATIVE_FILE = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r\\]{1,1024}$/u;
/** The per-file states a progress step may say. */
const PROGRESS_STATES = new Set(['waiting', 'running', 'green', 'red']);

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
 * The run is the argv a runner executes at the candidate commit [P7]. A payload, when given, is a small JSON object
 * the claiming runner gets back with its claim: what to work on, such as a landing's items and expected trunk sha.
 * A request is the job's own larger input, read back by the runner holding it with jobRequest: for a gate, the argv to
 * run and the data it reads on stdin [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, kind: string, needs?: string[], run?: string[], payload?: Record<string, unknown> | null, item?: number | null, candidate?: string | null, base?: string | null, request?: Record<string, unknown> | null, now?: number }} fields
 * @returns {ReturnType<typeof jobView>}
 */
export function offerJob(db, { id, kind, needs = [], run = [], payload = null, item = null, candidate = null, base = null, request = null, now = Date.now() }) {
  const wanted = names(needs, 'needs');
  const argv = runArgv(run);
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) throw new Refused('JOB_PAYLOAD', 'a job payload is a JSON object; offer { payload: { ... } } or none');
  if (payload !== null && Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_BYTES) throw new Refused('JOB_PAYLOAD', `a job payload is at most ${PAYLOAD_BYTES} bytes; name commits and refs, and let the runner fetch the code from git`);
  if (request !== null && (typeof request !== 'object' || Array.isArray(request) || Buffer.byteLength(JSON.stringify(request)) > REQUEST_BYTES)) {
    throw new Refused('JOB_REQUEST', `a job request is a JSON object of at most ${REQUEST_BYTES} bytes; keep large inputs in git and name them`);
  }
  return atomically(db, () => {
    const job = createJob(db, { id, kind, item, candidate, base, now });
    if (job.step === 'queued' && job.steps.length === 0) writeStep(db, id, 'offered', { needs: wanted, ...(argv.length ? { run: argv } : {}), ...(payload === null ? {} : { payload }), ...(request ? { request } : {}) }, { now });
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
 * True while the queue holds a job offered through it that has not finished: a gate or landing row a pull submit or
 * pilot wrote, offered or leased. Why: turning pull or its pilot off must let those jobs drain, so no queued or running
 * gate is stranded with its builder waiting; new submits already take the controller path [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function queueDraining(db) {
  return Boolean(db.prepare(`SELECT 1 FROM job JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_step <> 'done' LIMIT 1`).get());
}

/**
 * The mode a board's job queue answers in: pull while this machine wants pull gates (gate.runnerDispatch pull or a
 * pull pilot), and pull while jobs offered earlier still drain; controller otherwise [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => string} wanted - the machine's queue mode (the config cell's jobQueueMode).
 */
export function boardQueueMode(db, wanted) {
  return wanted() === 'pull' || queueDraining(db) ? 'pull' : 'controller';
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
 * @returns {{ job: string, kind: string, needs: string[], run: string[], payload?: Record<string, unknown>, item: number | null, candidate: string | null, base: string | null, attempt: number, leaseUntil: number, token: string } | null}
 *   null when no open job matches. The candidate and run tell a runner what to fetch and execute [P7]; payload only when the offer carried one.
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
      const { needs = [], run = [], payload = null } = JSON.parse(row.job_step_payload);
      if (only && !only.has(row.job_kind)) continue;
      if (!needs.every(need => has.has(need))) continue;
      const taken = db.prepare("UPDATE job SET job_lease_owner = ?, job_lease_until = ?, job_attempt = job_attempt + 1, job_updated = ? WHERE job_id = ? AND job_lease_until < ? AND job_step IN ('offered', 'claimed')")
        .run(runner, now + leaseMs, now, row.job_id, now);
      if (taken.changes !== 1) continue;
      const { job_attempt: attempt } = db.prepare('SELECT job_attempt FROM job WHERE job_id = ?').get(row.job_id);
      const token = randomBytes(24).toString('base64url');
      writeStep(db, row.job_id, 'claimed', { runner, capabilities: [...has], token: tokenHash(token) }, { seq: attempt, now });
      return { job: row.job_id, kind: row.job_kind, needs, run, ...(payload ? { payload } : {}), item: row.job_item, candidate: row.job_candidate, base: row.job_base, attempt, leaseUntil: now + leaseMs, token };
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
 * Record the latest test progress of a job's current claim: files selected, finished and failing so far, and each file's
 * state by repository-relative path. Only the runner whose token the current claim returned may post, as for a receipt
 * (#5758). Each attempt keeps one progress row, replaced by every post, and the job's own step is left as it is, so a
 * lapsed lease still reads as claimable and the board grows by one row per attempt, not one per post [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, progress: { selected?: number | null, finished: number, failures: number, files?: Record<string, string>, latest?: string[] }, now?: number }} request
 * @returns {{ job: string, attempt: number, recorded: boolean }}
 */
export function postProgress(db, { job, runner, token, progress, now = Date.now() }) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const files = progress?.files ?? {}, latest = progress?.latest ?? [];
  if (!progress || typeof progress !== 'object' || Array.isArray(progress) || !count(progress.finished) || !count(progress.failures)
    || (progress.selected != null && !count(progress.selected)) || !files || typeof files !== 'object' || Array.isArray(files) || !Array.isArray(latest)
    || Object.entries(files).some(([file, state]) => !RELATIVE_FILE.test(file) || !PROGRESS_STATES.has(state)) || latest.some(file => typeof file !== 'string' || !RELATIVE_FILE.test(file))) {
    throw new Refused('JOB_PROGRESS', 'progress is { finished, failures, selected?, files: { "<repo-relative path>": "waiting|running|green|red" }, latest: [paths] }; send repository-relative paths only');
  }
  const kept = { selected: progress.selected ?? null, finished: progress.finished, failures: progress.failures, files, latest };
  const text = JSON.stringify(kept);
  if (Buffer.byteLength(text) > PROGRESS_BYTES) throw new Refused('JOB_PROGRESS', `a progress step is at most ${PROGRESS_BYTES} bytes; send finished and running files only`);
  return atomically(db, () => {
    const { attempt, step } = heldBy(db, job, runner, token);
    if (step === 'done') throw new Refused('JOB_DONE', `job ${job} already posted its receipt; progress ends with the receipt`);
    db.prepare(`INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, 'progress', ?, ?, ?)
      ON CONFLICT (job_step_job, job_step_name, job_step_seq) DO UPDATE SET job_step_payload = excluded.job_step_payload, job_step_at = excluded.job_step_at`).run(job, attempt, text, now);
    return { job, attempt, recorded: true };
  });
}

/**
 * Answer one queue call as the board API carries it: `{ action: 'claim' | 'request' | 'renew' | 'release' | 'progress' | 'receipt', ... }`.
 * The queue answers only while the machine runs runner jobs by pull, so today's path never sees it. A claim also names
 * the board's trunk remote, the one place a runner fetches the candidate from, kept apart from the board host [P7].
 *
 * A receipt newly recorded is handed to `onReceipt`, which applies it to the board (a gate's result to its item); its
 * answer rides back as `applied`. An apply that refuses leaves the receipt recorded and says why, so a runner's retried
 * post never records it twice [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} body
 * @param {{ mode: string, now?: number, trunk?: () => string | null, onReceipt?: ((posted: { job: string, attempt: number, receipt: Record<string, unknown> }) => object) | null }} options - mode is the machine's gate.runnerDispatch.
 * @returns {object}
 */
export function jobQueueCall(db, body, { mode, now = Date.now(), trunk = () => null, onReceipt = null }) {
  if (mode !== 'pull') throw new Refused('JOBS_NOT_PULL', 'this board serves its runner job queue only when gate.runnerDispatch is pull; set it with pullboard settings');
  const { action, runner, capabilities, kinds, job, token, receipt, progress } = body ?? {};
  if (action === 'claim') {
    const claim = claimJob(db, { runner, capabilities, kinds: kinds ?? null, now });
    return { claim, ...(claim ? { trunk: trunk() } : {}) };
  }
  if (action === 'request') return jobRequest(db, { job, runner, token });
  if (action === 'renew') return renewJob(db, { job, runner, token, now });
  if (action === 'release') return releaseJob(db, { job, runner, token, now });
  if (action === 'progress') return postProgress(db, { job, runner, token, progress, now });
  if (action === 'receipt') {
    const posted = postReceipt(db, { job, runner, token, receipt, now });
    if (!posted.recorded || !onReceipt) return posted;
    try { return { ...posted, applied: onReceipt(posted) }; }
    catch (error) { if (!error?.code) throw error; return { ...posted, applied: { applied: false, outcome: 'refused', reason: `${error.code}: ${error.message}` } }; }
  }
  throw new Refused('JOB_ACTION', 'a job queue call names its action: claim, request, renew, release, progress or receipt');
}
