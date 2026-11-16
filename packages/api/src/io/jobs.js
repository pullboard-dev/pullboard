/** The board's runner job queue, served by the board API and kept out of the runner worker's import graph: offer a job with the capabilities it needs, claim by capability, renew, release, post progress, run artifacts and a receipt [P7]. */
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { atomically } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { readPayload } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { upsertProgressStep } from '../../../jobs/index.js';
import { upsertArtifactStep } from '../../../jobs/index.js';
import { readArtifactSteps } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { JOB_CLASSES } from '../../../jobs/index.js';
import { claimableJobs } from '../../../jobs/index.js';
import { backOffLease } from '../../../jobs/index.js';
import { ledgerHits } from '../../../store/index.js';
import { recordShadow } from '../../../store/index.js';
import { firstDifference } from '../../../store/index.js';
import { touchLive } from '../../../jobs/index.js';
import { liveSince } from '../../../jobs/index.js';
import { endJob } from '../../../jobs/index.js';
import { noteLease } from '../../../jobs/index.js';
import { setJobRow } from '../../../jobs/index.js';
import { moveGateClaimHop } from './hop.js';
import { queueOffer } from './queue.js';
import { freeGateHop } from './hop.js';

/** The job kind of one part of a pulled gate's proof, which the board offers from the gate's plan and any runner pulls [P7]. */
export const SHARD_JOB_KIND = 'gate-shard';
// Budget: a runner holds one gate shard per this many cores at a time, as a serve's default slots do (drive's CORES_PER_JOB), however many slots it was set to.
const CORES_PER_SHARD = 3;

/**
 * The most gate-shard jobs one runner holds at once: one per CORES_PER_SHARD cores, at least one. Why: the first two
 * runners to poll took all 18 shards of a dry push gate within a second and ran 8 and 10 at once on 10 cores, while four
 * runners idled and the heaviest shard passed the 20-minute ceiling (#7765); a cap by cores leaves the rest to them.
 *
 * @param {number} cores - The cores the runner reported with its claim.
 * @returns {number}
 */
export function shardClaimCap(cores) {
  return Math.max(1, Math.floor(cores / CORES_PER_SHARD));
}

/** How many gate-shard jobs this runner holds a live lease on now. runs: the board's runs holder while runs_store is on, so the rows are read from the runs file; null reads the board's [B2,P7,#9151]. */
export function heldShards(db, runner, now, { runs = null } = {}) {
  return (runs ? runs.db : db).prepare("SELECT COUNT(*) AS held FROM job WHERE job_kind = ? AND job_lease_owner = ? AND job_lease_until >= ? AND job_step IN ('offered', 'claimed')").get(SHARD_JOB_KIND, runner, now).held;
}

/**
 * How many census test jobs this runner holds a live lease on now: jobs offered with a censusPerRunner cap.
 * Why: census 4 ran ten census jobs at once on each 10-core runner (load 17-22), so files ran 4-16x slow [C7,#9136].
 */
function heldCensus(db, runner, now) {
  return db.prepare(`SELECT COUNT(*) AS held FROM job JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_lease_owner = ? AND job.job_lease_until >= ? AND job.job_step IN ('offered', 'claimed') AND json_extract(step.job_step_payload, '$.censusPerRunner') IS NOT NULL`).get(runner, now).held;
}

/**
 * How many jobs this runner holds a live lease on now that are not census jobs (no censusPerRunner on the offer).
 * Why: a runner holding only census jobs is quiet by its own doing, so census.jobsPerRunnerQuiet may offer it more of them [C7,#9500].
 */
function heldOther(db, runner, now) {
  return db.prepare(`SELECT COUNT(*) AS held FROM job JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_lease_owner = ? AND job.job_lease_until >= ? AND job.job_step IN ('offered', 'claimed') AND json_extract(step.job_step_payload, '$.censusPerRunner') IS NULL`).get(runner, now).held;
}

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
// Budget: a request part this large or larger may be named by board id in the offered row instead of inlined.
const PART_BYTES = 1024;
// Budget: a whole request kept in its job's own request step, read only by the runner holding the job (#6150).
const STORED_REQUEST_BYTES = 4 * 1024 ** 2;
// Budget: a job is claimed at most this many times (gate.jobMaxAttempts); at the cap it ends as a runaway and the coordinator hears once (#7386).
export const JOB_MAX_ATTEMPTS = 12;
// Budget: a pre-push gate renews its shards' liveness every 30 s; a shard unrenewed for this long has lost its gate and ends at its next claim (#7805).
export const PUSH_ALIVE_MS = 5 * 60_000;
/** The step a request too large for its offered row is kept in; its parts in the offer name it. */
const REQUEST_STEP = 'request';
// Budget: a progress step names each file once with a state word; it stays inline, under the 64 KiB blob threshold, so the live reader parses the row itself.
const PROGRESS_BYTES = 60 * 1024;
// Budget: one posted artifact (a job log or report) is at most this many bytes, and an attempt keeps at most ARTIFACT_COUNT; a runner caps its output the same way.
const ARTIFACT_BYTES = 8 * 1024 ** 2;
const ARTIFACT_COUNT = 16;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
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

/** Refuse a priority class that is not one of JOB_CLASSES; return it, or null for none. */
function jobClass(name) {
  if (name === null || name === undefined) return null;
  if (!JOB_CLASSES.includes(name)) throw new Refused('JOB_PRIORITY', `a job's priority is one of ${JOB_CLASSES.join(', ')}; offer { priority: "interactive" }`);
  return name;
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
 * The priority is the job's class, set here by the command that enqueues it and never by a runner (JOB_CLASSES).
 * An avoid list names runners that must not take the job; claimJob honours it only behind jobs.avoidRunners [C7,#9273].
 * A request is the job's own larger input, read back by the runner holding it with jobRequest: for a gate, the argv to
 * run and the data it reads on stdin [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, kind: string, needs?: string[], run?: string[], payload?: Record<string, unknown> | null, item?: number | null, candidate?: string | null, base?: string | null, request?: Record<string, unknown> | null, priority?: string | null, censusPerRunner?: number | null, censusPerRunnerQuiet?: number | null, avoid?: string[], now?: number }} fields
 * @returns {ReturnType<typeof jobView>}
 */
export function offerJob(db, { id, kind, needs = [], run = [], payload = null, item = null, candidate = null, base = null, request = null, priority = null, censusPerRunner = null, censusPerRunnerQuiet = null, avoid = [], now = Date.now() }, queue = null) {
  if (censusPerRunner !== null && !(Number.isSafeInteger(censusPerRunner) && censusPerRunner >= 1)) throw new Refused('JOB_CENSUS_CAP', 'a census job\'s censusPerRunner is a whole number of jobs, 1 or more', 'offer it with census.jobsPerRunner as set, or none');
  if (censusPerRunnerQuiet !== null && !(Number.isSafeInteger(censusPerRunnerQuiet) && censusPerRunnerQuiet >= 1)) throw new Refused('JOB_CENSUS_CAP', 'a census job\'s censusPerRunnerQuiet is a whole number of jobs, 1 or more', 'offer it with census.jobsPerRunnerQuiet as set, or none');
  const wanted = names(needs, 'needs');
  const avoided = names(avoid, 'avoid');
  const rank = jobClass(priority);
  const argv = runArgv(run);
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) throw new Refused('JOB_PAYLOAD', 'a job payload is a JSON object; offer { payload: { ... } } or none');
  if (payload !== null && Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_BYTES) throw new Refused('JOB_PAYLOAD', `a job payload is at most ${PAYLOAD_BYTES} bytes; name commits and refs, and let the runner fetch the code from git`);
  if (request !== null && (typeof request !== 'object' || Array.isArray(request) || Buffer.byteLength(JSON.stringify(request)) > STORED_REQUEST_BYTES)) {
    throw new Refused('JOB_REQUEST', `a job request is a JSON object of at most ${STORED_REQUEST_BYTES} bytes; keep large inputs in git and name them`);
  }
  const offered = request === null ? null : namedRequest(request);
  if (offered && Buffer.byteLength(JSON.stringify(offered)) > REQUEST_BYTES) {
    throw new Refused('JOB_REQUEST', `a job request's offered row is a JSON object of at most ${REQUEST_BYTES} bytes once its parts of ${PART_BYTES} bytes or more are named; keep large inputs in git and name them`);
  }
  const row = { needs: wanted, ...(rank ? { priority: rank } : {}), ...(argv.length ? { run: argv } : {}), ...(payload === null ? {} : { payload }), ...(offered ? { request: offered } : {}), ...(censusPerRunner ? { censusPerRunner } : {}), ...(censusPerRunner && censusPerRunnerQuiet ? { censusPerRunnerQuiet } : {}), ...(avoided.length ? { avoid: avoided } : {}) };
  // With runs_store on the offer goes through queueRun: the runs file holds the job, the board one queued run row [B2,P7].
  if (queue) return queueOffer(queue, { id, kind, item, candidate, base, request, offered: row });
  return atomically(db, () => {
    const job = createJob(db, { id, kind, item, candidate, base, now });
    if (job.step === 'queued' && job.steps.length === 0) {
      // The whole request goes in first, so the job's step ends on offered and the claim scan finds it.
      if (offered !== request) writeStep(db, id, REQUEST_STEP, { request }, { now });
      writeStep(db, id, 'offered', row, { now });
    }
    return jobView(db, id);
  });
}

/**
 * The request as its offered row keeps it: the request itself when it fits REQUEST_BYTES, else a copy whose largest
 * parts (strings and lists of PART_BYTES or more, largest first) are each replaced by a name for the job's request
 * step, until it fits. Why: the claim scan reads every open offered row, so a row stays small however large a gate's
 * inputs grow (#5417's 61,582-byte request); the whole request is read back only by the runner that holds the job (#6150).
 *
 * @param {Record<string, unknown>} request
 * @returns {Record<string, unknown>}
 */
function namedRequest(request) {
  let size = Buffer.byteLength(JSON.stringify(request));
  if (size <= REQUEST_BYTES) return request;
  const copy = structuredClone(request), parts = [];
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const bytes = Buffer.byteLength(JSON.stringify(child) ?? '');
      if ((typeof child === 'string' || Array.isArray(child)) && bytes >= PART_BYTES) parts.push({ holder: value, key, path: [...path, key], bytes });
      else walk(child, [...path, key]);
    }
  };
  walk(copy, []);
  for (const part of parts.sort((a, b) => b.bytes - a.bytes)) {
    if (size <= REQUEST_BYTES) break;
    const name = { $named: REQUEST_STEP, path: part.path, bytes: part.bytes };
    part.holder[part.key] = name;
    size += Buffer.byteLength(JSON.stringify(name)) - part.bytes;
  }
  return copy;
}

/** True when an offered request names a part of itself kept in the job's request step. */
function namesParts(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.$named === REQUEST_STEP) return true;
  return Object.values(value).some(namesParts);
}

/**
 * The whole request a job was offered with, or null: the offered row's request, read back from the job's request
 * step when the row names its parts there [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on, so the offered and kept steps are read from the runs file [#9151].
 * @returns {Record<string, unknown> | null}
 */
export function offeredRequest(db, job, { runs = null } = {}) {
  if (runs) db = runs.db;
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job);
  const request = row ? JSON.parse(row.job_step_payload).request ?? null : null;
  if (!namesParts(request)) return request;
  // A queued job (runs_store on) keeps its whole request in the pending step intend wrote, not in a request step.
  const kept = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name IN (?, 'pending') AND job_step_seq = 0 ORDER BY job_step_name = 'pending'").get(job, REQUEST_STEP);
  const whole = kept ? readPayload(db, kept.job_step_payload) : null;
  if (!whole?.request) throw new Refused('JOB_REQUEST', `job ${job}'s offer names its request step, but the board no longer holds it; resubmit the item for a new gate job`);
  return whole.request;
}

/**
 * The job of a kind offered for one item's candidate that has not finished, or null: a retried offer reuses it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kind: string, item: number, candidate: string }} fields
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on, so the job is read from the runs file [#9151].
 * @returns {ReturnType<typeof jobView> | null}
 */
export function openJob(db, { kind, item, candidate }, { runs = null } = {}) {
  if (runs) db = runs.db;
  const row = db.prepare(`SELECT job.job_id FROM job JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_kind = ? AND job.job_item = ? AND job.job_candidate = ? AND job.job_step <> 'done' ORDER BY job.job_created DESC LIMIT 1`).get(kind, item, candidate);
  return row ? jobView(db, row.job_id) : null;
}

/**
 * Each named job's view, or null for one gone from the board. Why: the pre-push gate waits on its item-less shard jobs
 * through the board API, as a runner reads the queue [P7,#7743].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids
 * @returns {(ReturnType<typeof jobView> | null)[]}
 */
export function jobViews(db, ids) {
  return ids.map(id => jobView(db, id));
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
 * With a reserve (gate.jobReserve), the claim takes the highest priority class first and keeps each class its reserved
 * share of the runner's `jobs` slots; with none, pre-push gate shards first (#7790), then landing jobs, test runs and the rest, each by age (claimableJobs) [C7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ runner: string, capabilities?: string[], kinds?: string[] | null, now?: number, leaseMs?: number, reserve?: Record<string, number> | null }} request
 * @returns {{ job: string, kind: string, needs: string[], run: string[], payload?: Record<string, unknown>, item: number | null, candidate: string | null, base: string | null, attempt: number, leaseUntil: number, token: string } | null}
 *   null when no open job matches. The candidate and run tell a runner what to fetch and execute [P7]; payload only when the offer carried one.
 */
export function claimJob(db, { runner, capabilities = [], kinds = null, jobs = null, cores = null, ram = null, now = Date.now(), leaseMs = LEASE_MS, drained = [], reserve = null, maxAttempts = JOB_MAX_ATTEMPTS, onRunaway = null, onRepeatClaim = null, hop = null, avoidRunners = false }) {
  runnerId(runner);
  // A drained runner (`pullboard runner drain`) finishes the jobs it holds and is offered no new one.
  if (drained.includes(runner)) return null;
  const has = new Set(names(capabilities, 'capabilities'));
  const only = kinds === null ? null : new Set(names(kinds, 'kinds'));
  const ended = [];
  const repeated = [];
  const claimed = atomically(db, () => {
    // A runner that reported its cores and holds its cap of gate shards is offered no more, so idle runners get the rest (#7765).
    const shardsFull = Number.isSafeInteger(cores) && cores >= 1 && heldShards(db, runner, now) >= shardClaimCap(cores);
    // A census job offered with census.jobsPerRunner set waits while this runner holds that many census jobs; other jobs are offered as before [C7,#9136].
    let census = null;
    // With census.jobsPerRunnerQuiet also set, a runner holding no job but census ones is offered up to that many instead [C7,#9500].
    let other = null;
    const censusCap = offer => (offer.censusPerRunnerQuiet && (other ??= heldOther(db, runner, now)) === 0 ? Math.max(offer.censusPerRunnerQuiet, offer.censusPerRunner) : offer.censusPerRunner);
    const censusFull = offer => offer.censusPerRunner && (census ??= heldCensus(db, runner, now)) >= censusCap(offer);
    const ordered = claimableJobs(db, { runner, now, limit: SCAN_ROWS, reserve, slots: jobs,
      runnable: (row, offer) => (!only || only.has(row.job_kind)) && !(shardsFull && row.job_kind === SHARD_JOB_KIND) && !censusFull(offer) && !(avoidRunners === true && (offer.avoid ?? []).includes(runner)) && (offer.needs ?? []).every(need => has.has(need)) });
    for (const { row, offer } of ordered) {
      const { needs = [], run = [], payload = null } = offer;
      // A push shard whose pushing gate stopped renewing it is no one's work: it ends here, never rerun (#7805).
      if (isPushShard(row) && now - liveSince(db, row.job_id) > PUSH_ALIVE_MS) { endAbandoned(db, row, { now }); continue; }
      // A job claimed this many times is a runaway: it ends here and no runner takes it again.
      if (row.job_attempt >= maxAttempts) { endRunaway(db, row, { now, ended }); continue; }
      const taken = db.prepare("UPDATE job SET job_lease_owner = ?, job_lease_until = ?, job_attempt = job_attempt + 1, job_updated = ? WHERE job_id = ? AND job_lease_until < ? AND job_step IN ('offered', 'claimed')")
        .run(runner, now + leaseMs, now, row.job_id, now);
      if (taken.changes !== 1) continue;
      const { job_attempt: attempt } = db.prepare('SELECT job_attempt FROM job WHERE job_id = ?').get(row.job_id);
      const token = randomBytes(24).toString('base64url');
      // With gate.fencedHop on, a gate job's runner owns its item's hop row; a hop another live runner holds refuses the claim HOP_FENCED [C7,#8352].
      const held = hop && row.job_kind === 'gate' && row.job_item ? acquireOrEnd(db, hop, row, { runner, now, leaseMs }) : null;
      if (held === OVER) continue;
      writeStep(db, row.job_id, 'claimed', { runner, ...(held ? { hopEpoch: held.epoch } : {}), capabilities: [...has], ...(Number.isSafeInteger(jobs) && jobs >= 1 ? { jobs } : {}), ...(Number.isSafeInteger(cores) && cores >= 1 ? { cores } : {}), ...(Number.isSafeInteger(ram) && ram >= 1 ? { ram } : {}), token: tokenHash(token) }, { seq: attempt, now });
      noteLease(db, row.job_id, 'lease.grant', { owner: runner, until: now + leaseMs }, now);
      noteRepeatClaims(db, row, { now, repeated });
      return { job: row.job_id, kind: row.job_kind, needs, run, ...(payload ? { payload } : {}), item: row.job_item, candidate: row.job_candidate, base: row.job_base, attempt, leaseUntil: now + leaseMs, token };
    }
    return null;
  });
  // The shout is a board write of its own, so it follows the claim's transaction.
  for (const runaway of ended) { try { onRunaway?.(runaway); } catch { /* a shout that cannot send leaves the job ended */ } }
  for (const repeat of repeated) { try { onRepeatClaim?.(repeat); } catch { /* a shout that cannot send leaves the claim made */ } }
  return claimed;
}

/** acquireOrEnd's answer for a gate job it ended because its hop is over. */
const OVER = Symbol('hop over');

/**
 * Acquire the item's hop for this gate job's claim, or end the job when its own candidate's hop is already done or ended.
 * Why: a resubmit ends the old candidate's hop but leaves its gate job open; once that job's lease lapsed, every claim
 * reached it first and was refused HOP_OVER, so no gate job behind it was ever claimed. A job whose hop is over is no
 * one's work, so it ends here like a runaway and the claim goes on to the next job [C7,#8352,#8353].
 *
 * @returns {{ owner: string | null, epoch: number } | typeof OVER}
 */
function acquireOrEnd(db, hop, row, { runner, now, leaseMs }) {
  try {
    return moveGateClaimHop(db, hop, { item: row.job_item, candidate: row.job_candidate, runner, move: 'acquire', job: row.job_id, now, leaseMs });
  } catch (error) {
    if (error?.code !== 'HOP_OVER') throw error;
    endJob(db, row.job_id, 'superseded', { detail: `#${row.job_item}'s gate hop at ${String(row.job_candidate).slice(0, 12)} is already done or ended; ended, not rerun` }, { now });
    return OVER;
  }
}

/** The window in which this many claims of one job make the sentinel shout, and the claim count that trips it (#7445). */
const REPEAT_CLAIM_WINDOW_MS = 60_000;
const REPEAT_CLAIM_COUNT = 3;

/**
 * Queue one sentinel report when this claim is the third of the job within 60 s, naming its runners. Why only the third:
 * a runaway re-claimer would otherwise shout on every claim; the count passing 3 adds nothing, so the coordinator hears once [C7,P7].
 */
function noteRepeatClaims(db, row, { now, repeated }) {
  const recent = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'claimed' AND job_step_at > ?").all(row.job_id, now - REPEAT_CLAIM_WINDOW_MS);
  if (recent.length !== REPEAT_CLAIM_COUNT) return;
  const runners = [...new Set(recent.map(step => { try { return JSON.parse(step.payload).runner; } catch { return null; } }).filter(Boolean))];
  repeated.push({ job: row.job_id, kind: row.job_kind, claims: recent.length, runners });
}

/** True for a pre-push gate's shard job: a gate-shard whose id starts with `push:` (the gate that offered it renews it). */
function isPushShard(row) {
  return row.job_kind === SHARD_JOB_KIND && row.job_id.startsWith('push:');
}

/** End a push shard whose gate stopped renewing it: an `abandoned` step, then done. No shout: a stopped gate is not a fault to report. */
function endAbandoned(db, row, { now }) {
  endJob(db, row.job_id, 'abandoned', { attempts: row.job_attempt, detail: `its push gate stopped renewing it ${PUSH_ALIVE_MS / 60_000} minutes ago; ended, not rerun` }, { now });
}

/**
 * Say a pre-push gate still waits on these shard jobs, so no claim ends them as abandoned (PUSH_ALIVE_MS).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids
 * @param {number} [now]
 */
export function keepJobsAlive(db, ids, now = Date.now()) {
  touchLive(db, ids, now);
}

/**
 * End each of these jobs that has not finished, even one a runner holds: a pre-push gate that blocks, times out or is
 * interrupted withdraws its shards, so no runner claims them again (#7805).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids
 * @param {{ reason?: string, now?: number }} [options]
 * @returns {string[]} The jobs ended now.
 */
export function endJobs(db, ids, { reason = 'withdrawn by the process that offered it', now = Date.now() } = {}) {
  return ids.filter(id => endJob(db, id, 'withdrawn', { detail: reason }, { now }));
}

/** End a job claimed past its cap: a `runaway` step, then done, queued on `ended` for `onRunaway` so the coordinator hears once. */
function endRunaway(db, row, { now, ended }) {
  const detail = `claimed ${row.job_attempt} times without finishing; ended as a runaway`;
  if (!writeStep(db, row.job_id, 'runaway', { attempts: row.job_attempt, detail }, { seq: row.job_attempt, now }).written) return;
  finishJob(db, row.job_id, '', { now });
  ended.push({ job: row.job_id, kind: row.job_kind, attempts: row.job_attempt, detail });
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
  return { attempt: row.job_attempt, step: row.job_step, hopEpoch: stored.hopEpoch };
}

/**
 * The job row as the job table reads it: kind, step, attempt, lease and the current attempt's claim, or null for no job.
 * Why: the table's claim token is the hash the board keeps, so the move carries the hash too and the two compare like for like.
 */
function jobSnapshot(db, job, now) {
  const row = db.prepare('SELECT job_kind, job_step, job_attempt, job_lease_owner, job_lease_until FROM job WHERE job_id = ?').get(String(job ?? ''));
  if (!row) return { job: null, now };
  const claimed = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'claimed' AND job_step_seq = ?").get(job, row.job_attempt);
  let claim = null;
  try { const payload = claimed ? JSON.parse(claimed.job_step_payload) : null; claim = payload ? { runner: payload.runner, token: payload.token } : null; } catch { claim = null; }
  return { job: { kind: row.job_kind, step: row.job_step, attempt: row.job_attempt, owner: row.job_lease_owner, leaseUntil: row.job_lease_until, claim }, now };
}

/** The job table's decision the serving app provides: `(snapshot, move) => answer`. Why provided: the api cell sits below moves, so the app that composes both hands the table in [C7,#8381]. */
let jobTable = null;
/** The moves.shadow machine setting, handed in with the table because the api cell may not read config [C7,#8381]. */
let shadowEnabled = () => false;
/** The moves.live.job machine setting, handed in the same way; the writer follows the table only while it reads true [C7,#8387]. */
let liveEnabled = () => false;

/**
 * Provide the job table the writer's shadow compare decides with, once per serving process or handler worker.
 *
 * @param {((snapshot: object, move: object) => { refused?: object, patch?: { job: object } }) | null} decide
 * @param {() => boolean} [enabled] - Reads the moves.shadow machine setting; the shadow stays off without it.
 * @param {() => boolean} [live] - Reads the moves.live.job machine setting; the writer's own rules decide without it.
 */
export function provideJobTable(decide, enabled = () => false, live = () => false) {
  jobTable = typeof decide === 'function' ? decide : null;
  shadowEnabled = typeof enabled === 'function' ? enabled : () => false;
  liveEnabled = typeof live === 'function' ? live : () => false;
}

/** Where the job table's answer and the writer's row part: the first differing path, or null when they agree. */
function jobDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  return firstDifference(decided, wrote);
}

/**
 * The shadow the job writer hands its compare to: the db's own `jobQueueShadow` when a caller set one (a test), else, with moves.shadow on
 * and a provided table, one that records each compare in the board's counts for the `job` table, else null so the writer runs no table at all.
 * A db's own `movesShadow` stands in for the machine setting, as a board's does for the store writers [C7,#8381].
 */
function shadowOf(db) {
  const own = db.jobQueueShadow;
  if (typeof own?.decide === 'function' && typeof own.seen === 'function') return own;
  if (!jobTable || !(db.movesShadow ?? shadowEnabled())) return null;
  const decide = jobTable;
  return { recorder: true,
    decide: (snapshot, move) => { try { return decide(snapshot, move); } catch (error) { return { threw: error?.code ?? String(error?.message ?? error) }; } },
    seen: compare => recordShadow({ db }, 'job', compare.job, jobDiffers(compare)) };
}

/**
 * With moves.live.job on, the job table decides the move: it refuses before anything is written, and the job row it names is the one left behind.
 * The writer still records the steps the table does not model; then the row's step, owner and lease are set to the table's answer.
 * A table that throws never takes the runner's move down: the writer's own rules decide that move [C7,#8387].
 */
function followTable(db, move, now, write) {
  let answer;
  try { answer = jobTable(jobSnapshot(db, move.job, now), { ...move, token: tokenHash(move.token ?? '') }); } catch { return write(); }
  if (answer?.refused) throw new Refused(answer.refused.code, answer.refused.message ?? `the job table refused ${move.name} on job ${move.job}`, answer.refused.next);
  const decided = answer?.patch?.job;
  if (!decided) return write();
  return atomically(db, () => {
    const result = write();
    setJobRow(db, move.job, decided, { now });
    return result;
  });
}

/**
 * Run a runner's move through the writer and, when a shadow is set, hand it the job table's answer beside the writer's.
 * The shadow brings the table as `decide(snapshot, move)`, the job table run over the row before the move, and gets `seen({ move, job, decided, wrote })`:
 * a test's `jobQueueShadow` on the db, or, with moves.shadow on, the recorder that counts each compare on the board.
 * Why shadow first and injected: the writer stays the authority until every compare agrees, a db without a shadow runs no table,
 * and the api cell sits below moves, so the caller hands the table in rather than this file importing it [C7,#8310,#8381].
 *
 * @param {import('node:sqlite').DatabaseSync & { jobQueueShadow?: { decide: Function, seen: Function }, movesShadow?: boolean }} db
 * @param {{ name: string, job: string, runner: string, token: string, free?: boolean }} move
 * @param {number} now
 * @param {() => any} write - The writer's own move.
 */
function shadowed(db, move, now, write) {
  if (jobTable && (db.movesLive?.job ?? liveEnabled()) === true) return followTable(db, move, now, write);
  const shadow = shadowOf(db);
  if (!shadow) return write();
  // The table reads the row, the writer moves it and the compare reads it back in one write transaction: a runner's receipt landing
  // from another process between the table's read and the write would otherwise leave the table on `claimed` and the row on `done` [C7,#9360].
  let seen;
  try {
    return atomically(db, () => {
      const answer = shadow.decide(jobSnapshot(db, move.job, now), { ...move, token: tokenHash(move.token ?? '') });
      const decided = answer.threw ? { threw: answer.threw } : answer.refused ? { refused: answer.refused.code } : { job: answer.patch?.job };
      let result;
      try { result = write(); } catch (error) {
        seen = { move: move.name, job: move.job, decided, wrote: { refused: error.code } };
        throw error;
      }
      shadow.seen({ move: move.name, job: move.job, decided, wrote: { job: jobSnapshot(db, move.job, now).job } });
      return result;
    });
  } catch (error) {
    // A refused move rolls its transaction back, so its compare is recorded after it, as before.
    if (seen) shadow.seen(seen);
    throw error;
  }
}

/**
 * Extend the lease of the runner holding a job's current claim, even one that lapsed while the board could not answer:
 * the token proves no runner claimed it since (#6546). False once the job was released; a newer claim refuses.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, now?: number, leaseMs?: number }} request
 * @returns {{ renewed: boolean, leaseUntil: number | null }}
 */
export function renewJob(db, { job, runner, token, now = Date.now(), leaseMs = LEASE_MS, hop = null }) {
  return shadowed(db, { name: 'renew', job, runner, token }, now, () => renewHeld(db, { job, runner, token, now, leaseMs, hop }));
}

/** Step the item's hop as a gate job's claim at the epoch it took, refused HOP_FENCED when that claim no longer owns it [C7,#8352,#8353]. */
function stepClaimHop(db, hop, { job, runner, epoch, now, leaseMs }) {
  const row = db.prepare('SELECT job_item, job_candidate FROM job WHERE job_id = ?').get(job);
  moveGateClaimHop(db, hop, { item: row.job_item, candidate: row.job_candidate, runner, move: 'step', epoch, now, leaseMs });
}

/** Finish the item's hop as a gate job's claim at the epoch it took: the receipt is the gate's end, so its hop row reads done, not driven [C7,#8464]. */
function finishClaimHop(db, hop, { job, runner, epoch, now, leaseMs }) {
  const row = db.prepare('SELECT job_item, job_candidate FROM job WHERE job_id = ?').get(job);
  moveGateClaimHop(db, hop, { item: row.job_item, candidate: row.job_candidate, runner, move: 'finish', epoch, now, leaseMs });
}

/** The writer's renew: the claim's runner extends its lease, and with gate.fencedHop on steps its gate hop at the claim's epoch, so a replaced owner is refused HOP_FENCED [C7,#8352]. */
function renewHeld(db, { job, runner, token, now, leaseMs, hop }) {
  const held = heldBy(db, job, runner, token);
  if (hop && held.hopEpoch !== undefined) stepClaimHop(db, hop, { job, runner, epoch: held.hopEpoch, now, leaseMs });
  const renewed = renewLease(db, job, runner, { now, leaseMs, lapsed: true });
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
  return { job, kind: row.job_kind, item: row.job_item, candidate: row.job_candidate, base: row.job_base, request: offeredRequest(db, job) };
}

// Budget: one landing's proof splits into at most 32 shard jobs, as a gate's does (gate.js MAX_SHARDS).
const MAX_LAND_SHARDS = 32;
const PROOF_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
// The ref a land job pins its merged commit under on the trunk remote, which its shards' runners pull; packages/landing's landingRef names it.
const LAND_REF = /^refs\/pullboard\/landing\/[\w.-]{1,200}$/u;

/**
 * Offer a land job's proof as shard jobs on its runner's call: the plan's files split round-robin into one shard per
 * runner's worth of cores, each a gate-shard job `land:<job>:shard:N` any runner pulls. The runner holds the plan (the
 * proof's files and command, its cores) and the gate bootstrap to run it, and the board holds the queue and the ledger,
 * so it carries each shard's ledgerHits with the merged commit as source, as offerProofShards does for a gate [P7,C7,#7818].
 *
 * A shard offered for an earlier merged commit of the same land job (its trunk moved and it merged again) ends first, and a
 * shard id an earlier merged commit used is not reused: a retried land job never reads the old tree's receipts as its own [C7,#7818].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, merged: string, ref?: string | null, plan: { runner: string, files: string[], cores: number }, gate: { run: string[], entry: string, commits?: string[] }, now?: number }} request - ref: the landing ref holding the merged commit, which a shard's runner fetches.
 * @returns {{ sharded: boolean, shards: string[] }} Not sharded (no ids) when the plan is not one to split.
 */
export function offerLandShards(db, { job, runner, token, merged, ref = null, plan, gate, queue = null, now = Date.now() }) {
  // With runs_store on the land job and its shards live in the runs file; the ledger stays on the board's `db` [B2,P7].
  const jobs = queue ? queue.runs.db : db;
  const held = jobRequest(jobs, { job, runner, token });
  if (held.kind !== 'land') throw new Refused('JOB_NOT_LAND', `job ${job} is not a land job; only a land job's runner asks for its proof's shards`, 'ask for shards on the land job you hold');
  const files = Array.isArray(plan?.files) ? plan.files : [];
  const cores = Number.isSafeInteger(plan?.cores) && plan.cores > 0 ? plan.cores : 0;
  if (!FULL_SHA.test(merged ?? '')) throw new Refused('LAND_SHARDS', 'a land job\'s shards name the full merged commit they prove', 'send merged as the full sha');
  if (ref !== null && ref !== undefined && (typeof ref !== 'string' || !LAND_REF.test(ref))) throw new Refused('LAND_SHARDS', 'a land job\'s shards name their landing ref as refs/pullboard/landing/<name>', 'send ref as the landing ref the merged commit was pushed to');
  if (typeof plan?.runner !== 'string' || !plan.runner.trim() || /[\0\n\r]/u.test(plan.runner) || files.some(file => typeof file !== 'string' || !PROOF_FILE.test(file))
    || !Array.isArray(gate?.run) || !gate.run.length || typeof gate.entry !== 'string') throw new Refused('LAND_SHARDS', 'a land job\'s shard plan is { runner, files, cores } and its gate is { run, entry }', 'send both as the proof names them');
  if (!cores || files.length <= cores) return { sharded: false, shards: [] };
  const count = Math.min(MAX_LAND_SHARDS, Math.ceil(files.length / cores));
  const buckets = Array.from({ length: count }, () => []);
  files.forEach((file, at) => buckets[at % count].push(file));
  const prefix = `${job}:shard:`;
  // queueRun makes its own board transaction, so with runs_store on the offers do not sit inside a runs transaction.
  const ids = (queue ? work => work() : work => atomically(db, work))(() => {
    const prior = jobs.prepare('SELECT job_id, job_candidate, job_step FROM job WHERE job_kind = ? AND substr(job_id, 1, ?) = ?').all(SHARD_JOB_KIND, prefix.length, prefix);
    endJobs(jobs, prior.filter(row => row.job_candidate !== merged && row.job_step !== 'done').map(row => row.job_id), { reason: 'the land job proved another merged commit', now });
    return buckets.map((part, index) => {
      const named = `${prefix}${index + 1}`, taken = prior.find(row => row.job_id === named);
      const command = `${plan.runner.trim()} ${part.map(file => `'./${file.replaceAll("'", "'\\''")}'`).join(' ')}`;
      const ledger = ledgerHits(db, part, { budget: 16_000 });
      return offerJob(db, { id: taken && taken.job_candidate !== merged ? `${prefix}${merged.slice(0, 12)}-${index + 1}` : named, kind: SHARD_JOB_KIND, priority: 'gate', needs: held.request?.needs ?? [], candidate: merged, base: held.base, now,
        request: { run: gate.run, gate: job, commits: gate.commits ?? [], ...(ref ? { ref } : {}), input: { main: held.base, entry: gate.entry, data: { main: held.base, source: merged,
          shard: { index: index + 1, of: count, files: part, command, ...(ledger ? { ledger } : {}) } } } } }, queue).id;
    });
  });
  return { sharded: true, shards: ids };
}

/**
 * End the unfinished shards of a land job that has ended: its receipt is posted, so no runner should still claim or run them.
 * Why: a landing red on one shard returns at once, and the board holds the rest, so each would run its files for a result nobody reads [C7,#7818].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job - The land job's id.
 * @param {{ now?: number }} [options]
 * @returns {string[]} The shard jobs ended.
 */
export function withdrawLandShards(db, job, { now = Date.now() } = {}) {
  if (db.prepare('SELECT job_kind FROM job WHERE job_id = ?').get(job)?.job_kind !== 'land') return [];
  const prefix = `${job}:shard:`;
  const open = db.prepare("SELECT job_id FROM job WHERE job_kind = ? AND substr(job_id, 1, ?) = ? AND job_step <> 'done'").all(SHARD_JOB_KIND, prefix.length, prefix).map(row => row.job_id);
  return endJobs(db, open, { reason: 'the land job it served ended', now });
}

/**
 * The receipts a land job's shards have posted so far, for the land job's holder only: each shard's newest receipt step, or
 * null while it has none. Why: the runner holding the land job pushes trunk only when every shard is green, so it reads them back through the board API [P7,C7,#7818].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, shards: string[] }} request - shards: ids offerLandShards returned.
 * @returns {{ shards: { job: string, posted: { runner?: string, receipt?: object } | null }[] }}
 */
export function readLandShardReceipts(db, { job, runner, token, shards }) {
  heldBy(db, job, runner, token);
  const prefix = `${job}:shard:`;
  if (!Array.isArray(shards) || shards.length > MAX_LAND_SHARDS || shards.some(id => typeof id !== 'string' || !id.startsWith(prefix))) {
    throw new Refused('LAND_SHARDS', `a land job reads only its own shards, named ${prefix}<n>`, 'send the shard ids the shards action returned');
  }
  return { shards: shards.map(id => {
    const step = jobView(db, id)?.steps?.findLast(row => row.name === 'receipt');
    return { job: id, posted: step?.payload ?? null };
  }) };
}

/**
 * Hand a job back to the queue, before its lease would lapse, with the runner's reason: a runner that could not run it
 * frees it, and claim skips it for a backoff that grows per attempt so a failing job never spins (#6545). A stopping
 * runner passes backoff false and the job is free at once.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, reason?: string, backoff?: boolean, draining?: boolean, now?: number, hop?: { table: Function } | null }} request - hop: from gateClaimHop, null with gate.fencedHop off.
 * @returns {{ released: boolean, until?: number }}
 */
export function releaseJob(db, { job, runner, token, reason, backoff = true, draining = false, now = Date.now(), hop = null }) {
  return shadowed(db, { name: 'release', job, runner, token, free: backoff === false && draining }, now, () => releaseHeld(db, { job, runner, token, reason, backoff, draining, now, hop }));
}

/** The writer's release: back off, or free at once for a draining runner; a stopping runner's release also frees its gate hop. */
function releaseHeld(db, { job, runner, token, reason, backoff, draining, now, hop }) {
  return atomically(db, () => {
    const { attempt, hopEpoch } = heldBy(db, job, runner, token);
    // A stopping runner (backoff false) has ended its check, so its gate hop is freed with the lease: the next runner's claim takes the job without HOP_FENCED [C7,#8700].
    if (backoff === false && hop && hopEpoch !== undefined) freeGateHop(db, hop, { job, runner, epoch: hopEpoch, now });
    // A free release leaves no step and no backoff, so only a runner the board lists as draining may ask for one (#7386).
    if (backoff === false && draining) return { released: releaseLease(db, job, runner, { now }) };
    return backOffLease(db, job, runner, { attempt, reason: reason ?? 'unspecified', now });
  });
}

/**
 * Record the receipt for a job's current claim under that job and mark it done. Only the runner whose token the
 * current claim returned may post; a runner whose lease lapsed may still post while no other runner has claimed the
 * job since. Posting the same attempt's receipt again returns the stored one.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, receipt: Record<string, unknown>, now?: number, leaseMs?: number, hop?: { table: Function } | null }} request - hop: from gateClaimHop, null with gate.fencedHop off.
 * @returns {{ job: string, attempt: number, receipt: Record<string, unknown>, recorded: boolean }}
 */
export function postReceipt(db, { job, runner, token, receipt, now = Date.now(), leaseMs = LEASE_MS, hop = null }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Refused('JOB_RECEIPT', 'a receipt is a JSON object; post { receipt: { ... } }');
  if (Buffer.byteLength(JSON.stringify(receipt)) > RECEIPT_BYTES) throw new Refused('JOB_RECEIPT', `a receipt is at most ${RECEIPT_BYTES} bytes; keep output in a report file and post its digest`);
  return shadowed(db, { name: 'receipt', job, runner, token }, now, () => atomically(db, () => {
    const held = heldBy(db, job, runner, token);
    const { attempt } = held;
    // With gate.fencedHop on, a gate job lands only while its claim still owns the item's hop: a resubmit ended it, so the old job is refused HOP_FENCED [C7,#8353].
    if (hop && held.hopEpoch !== undefined) finishClaimHop(db, hop, { job, runner, epoch: held.hopEpoch, now, leaseMs });
    const written = writeStep(db, job, 'receipt', { runner, attempt, receipt }, { seq: attempt, now });
    finishJob(db, job, runner, { now });
    return { job, attempt, receipt: written.payload.receipt, recorded: written.written };
  }));
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
    upsertProgressStep(db, job, attempt, text, now);
    return { job, attempt, recorded: true };
  });
}

/**
 * Post a named run artifact (a log, a report) for the job's current claim, so the board holds it after the runner's folder
 * is gone. Only the runner whose token the current claim returned may post, as for a receipt; posting a name again
 * replaces it, and the job's own step is left as it is [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ job: string, runner: string, token: string, artifact: { name: string, body: string, encoding?: 'utf8'|'base64' }, now?: number }} request
 * @returns {{ job: string, attempt: number, name: string, bytes: number, recorded: boolean }}
 */
export function postArtifact(db, { job, runner, token, artifact, now = Date.now() }) {
  const encoding = artifact?.encoding ?? 'utf8';
  if (!artifact || typeof artifact !== 'object' || !ARTIFACT_NAME.test(artifact.name ?? '') || typeof artifact.body !== 'string' || !['utf8', 'base64'].includes(encoding)) {
    throw new Refused('JOB_ARTIFACT', 'an artifact is { name: "<file name>", body: "<text>", encoding?: "utf8"|"base64" }; name it by a plain file name, never a path');
  }
  const bytes = Buffer.from(artifact.body, encoding === 'base64' ? 'base64' : 'utf8').length;
  if (bytes > ARTIFACT_BYTES) throw new Refused('JOB_ARTIFACT', `an artifact is at most ${ARTIFACT_BYTES} bytes; post the head and tail of a larger log`);
  return atomically(db, () => {
    const { attempt } = heldBy(db, job, runner, token);
    const stepName = `artifact:${artifact.name}`;
    const have = db.prepare("SELECT job_step_name AS name FROM job_step WHERE job_step_job = ? AND job_step_seq = ? AND job_step_name LIKE 'artifact:%'").all(job, attempt);
    if (have.length >= ARTIFACT_COUNT && !have.some(row => row.name === stepName)) throw new Refused('JOB_ARTIFACT', `a job keeps at most ${ARTIFACT_COUNT} artifacts per attempt; replace one by name or fold them into one report`);
    upsertArtifactStep(db, job, attempt, artifact.name, { name: artifact.name, encoding, body: artifact.body }, now);
    return { job, attempt, name: artifact.name, bytes, recorded: true };
  });
}

/**
 * The artifacts a job's runner posted, by name, read from the board alone: a runner's folder may be long deleted.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {Map<string, Buffer>}
 */
export function jobArtifacts(db, job) {
  return readArtifactSteps(db, String(job ?? ''));
}

/**
 * Answer one queue call as the board API carries it: `{ action: 'claim' | 'request' | 'renew' | 'shards' | 'shardReceipts' | 'release' | 'progress' | 'artifact' | 'receipt', ... }`.
 * The queue answers only while the machine runs runner jobs by pull, so today's path never sees it. A claim also names
 * the board's trunk remote, the one place a runner fetches the candidate from, kept apart from the board host [P7].
 *
 * A receipt newly recorded is handed to `onReceipt`, which applies it to the board (a gate's result to its item); its
 * answer rides back as `applied`. An apply that refuses leaves the receipt recorded and says why, so a runner's retried
 * post never records it twice [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} body
 * @param {{ mode: string, now?: number, trunk?: () => string | null, reserve?: () => Record<string, number> | null, onReceipt?: ((posted: { job: string, attempt: number, receipt: Record<string, unknown> }) => object) | null }} options - mode is the machine's gate.runnerDispatch.
 * @returns {object}
 */
export function jobQueueCall(db, body, { mode, now = Date.now(), trunk = () => null, onReceipt = null, drained = () => [], reserve = () => null, onRunaway = null, onRepeatClaim = null, hop = null, queue = null, avoidRunners = false }) {
  if (mode !== 'pull') throw new Refused('JOBS_NOT_PULL', 'this board serves its runner job queue only when gate.runnerDispatch is pull; set it with pullboard settings');
  const { action, runner, capabilities, kinds, jobs, cores, ram, job, token, receipt, progress, reason, backoff } = body ?? {};
  if (action === 'claim') {
    const claim = claimJob(db, { runner, capabilities, kinds: kinds ?? null, jobs: jobs ?? null, cores: cores ?? null, ram: ram ?? null, now, drained: drained(), reserve: reserve(), onRunaway, onRepeatClaim, hop, avoidRunners });
    return { claim, ...(claim ? { trunk: trunk() } : {}) };
  }
  if (action === 'request') return jobRequest(db, { job, runner, token });
  if (action === 'renew') return renewJob(db, { job, runner, token, now, hop });
  if (action === 'shardReceipts') return readLandShardReceipts(db, { job, runner, token, shards: body.shards });
  if (action === 'shards') return offerLandShards(db, { job, runner, token, merged: body.merged, ref: body.ref, plan: body.plan, gate: body.gate, queue, now });
  if (action === 'release') return releaseJob(db, { job, runner, token, reason, backoff, draining: drained().includes(runner), now, hop });
  if (action === 'progress') return postProgress(db, { job, runner, token, progress, now });
  if (action === 'artifact') return postArtifact(db, { job, runner, token, artifact: body.artifact, now });
  if (action === 'receipt') {
    // With runs_store on (queue set) the job lives in the runs file, so the receipt posts there [B2,P7].
    const home = queue ? queue.runs.db : db;
    const posted = postReceipt(home, { job, runner, token, receipt, now, hop });
    if (posted.recorded) withdrawLandShards(home, job, { now });
    if (!posted.recorded || !onReceipt) return posted;
    try { return { ...posted, applied: onReceipt(posted) }; }
    catch (error) { if (!error?.code) throw error; return { ...posted, applied: { applied: false, outcome: 'refused', reason: `${error.code}: ${error.message}` } }; }
  }
  throw new Refused('JOB_ACTION', 'a job queue call names its action: claim, request, renew, shards, shardReceipts, release, progress, artifact or receipt');
}
