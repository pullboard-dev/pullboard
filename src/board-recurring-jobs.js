/**
 * A recurring job declares its cadence and owner, records each run, and a job that has not run within one
 * and a half cadences is a health finding that names it, its last run and its owner (#815) [D1,C7].
 * Declarations and runs are append-only board events, so the relay replays them like sentinel receipts.
 */
import {
  PERSON,
  atomic,
  listAgents,
  logEvent,
} from './board.js';
import { RECURRING_JOB_ENGINE } from './job-engine.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';

export { RECURRING_JOB_ENGINE };
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const UNIT_MS = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000 });
/** A job is missed after this many cadences without a run. */
export const MISSED_AFTER = 1.5;

/**
 * Read a cadence such as 10m, 2h, 1d, hourly or daily as milliseconds.
 *
 * @param {unknown} every
 * @returns {number}
 */
export function cadenceMs(every) {
  if (every === 'hourly') return UNIT_MS.h;
  if (every === 'daily') return UNIT_MS.d;
  const found = typeof every === 'string' ? /^([1-9]\d{0,3})([mhd])$/u.exec(every) : null;
  const ms = found ? Number(found[1]) * UNIT_MS[found[2]] : 0;
  if (!ms || ms < UNIT_MS.m || ms > 31 * UNIT_MS.d) {
    throw new Refused('BAD_JOB', 'name a job and its cadence, like 10m, 2h, 1d, hourly or daily: pullboard loop declare <name> --every 10m --owner <seat or lane>');
  }
  return ms;
}

/**
 * Read every declared job with its latest run. A later declaration replaces an earlier one's cadence
 * and owner but keeps its run history.
 *
 * @param {any} board
 * @returns {{ name: string, every: string, owner: string, declaredBy: string, declaredAt: string, lastRun: { by: string, at: string } | null, runs: number }[]}
 */
export function recurringJobs(board) {
  const jobs = new Map();
  const events = board.db.prepare("SELECT event_by, event_at, event_kind, event_detail FROM event WHERE event_kind IN ('job-declare','job-run') ORDER BY event_id").all();
  for (const event of events) {
    const detail = JSON.parse(event.event_detail);
    if (detail.engine !== RECURRING_JOB_ENGINE) continue;
    if (event.event_kind === 'job-declare') {
      const prior = jobs.get(detail.name);
      jobs.set(detail.name, { name: detail.name, every: detail.every, owner: detail.owner, declaredBy: event.event_by, declaredAt: prior?.declaredAt ?? event.event_at,
        lastRun: prior?.lastRun ?? null, runs: prior?.runs ?? 0 });
    } else if (jobs.has(detail.name)) {
      const job = jobs.get(detail.name);
      job.lastRun = { by: event.event_by, at: event.event_at };
      job.runs += 1;
    }
  }
  return [...jobs.values()];
}

/** Refuse a move on an engine too old to replay it. */
function requireJobEngine(board) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RECURRING_JOB_ENGINE) {
    throw new Refused('ENGINE_VERSION', `recurring jobs require engine ${RECURRING_JOB_ENGINE}; upgrade Pullboard`);
  }
}

/**
 * Declare or change a recurring job. Only the person or the coordinator sets a cadence, so an agent cannot
 * widen one to hide a stopped job.
 *
 * @param {any} board
 * @param {{ agentId: string, name: string, every: string, owner: string }} move
 * @returns {ReturnType<typeof recurringJobs>[number]}
 */
export function declareJob(board, { agentId, name, every, owner }) {
  return atomic(board, () => {
    requireJobEngine(board);
    if (agentId !== PERSON && agentId !== 'coordinator') {
      throw new Refused('JOB_CADENCE_COORDINATOR_ONLY', 'only the coordinator or the person declares or changes a job’s cadence');
    }
    if (typeof name !== 'string' || !NAME.test(name) || typeof owner !== 'string' || !owner.trim() || /\s/u.test(owner)) {
      throw new Refused('BAD_JOB', 'name a job and its cadence, like 10m, 2h, 1d, hourly or daily: pullboard loop declare <name> --every 10m --owner <seat or lane>');
    }
    cadenceMs(every);
    logEvent(board, agentId, 'job-declare', null, { name, every, owner, engine: RECURRING_JOB_ENGINE });
    return recurringJobs(board).find(job => job.name === name);
  });
}

/**
 * Record that a declared job just ran, by any joined seat.
 *
 * @param {any} board
 * @param {{ agentId: string, name: string }} move
 * @returns {ReturnType<typeof recurringJobs>[number]}
 */
export function recordJobRun(board, { agentId, name }) {
  return atomic(board, () => {
    requireJobEngine(board);
    if (!listAgents(board).some(agent => agent.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join this board before recording a run: pullboard join <lane>');
    if (!recurringJobs(board).some(job => job.name === name)) {
      throw new Refused('UNKNOWN_JOB', `no job named ${name}; the coordinator declares it first: pullboard loop declare ${name} --every 10m --owner <seat or lane>`);
    }
    logEvent(board, agentId, 'job-run', null, { name, engine: RECURRING_JOB_ENGINE });
    return recurringJobs(board).find(job => job.name === name);
  });
}

/**
 * The health findings for jobs that have not run within one and a half cadences. A job never run counts
 * from its declaration.
 *
 * @param {any} board
 * @param {number} now - Milliseconds since the epoch.
 * @returns {object[]}
 */
export function missedJobFindings(board, now) {
  const found = [];
  for (const job of recurringJobs(board)) {
    const since = job.lastRun?.at ?? job.declaredAt;
    const late = now - Date.parse(since);
    if (late <= cadenceMs(job.every) * MISSED_AFTER) continue;
    found.push({
      key: `JOB_MISSED:job:${job.name}`, cause: 'JOB_MISSED', item: null, subject: `job:${job.name}`, title: 'recurring job missed its cadence', since,
      ageMinutes: Math.max(0, Math.floor(late / 60_000)),
      why: `${job.name} should run ${job.every === 'daily' || job.every === 'hourly' ? job.every : `every ${job.every}`} and has not run since ${job.lastRun ? job.lastRun.at : `it was declared (${job.declaredAt})`}; its owner is ${job.owner}`,
      next: `find out why ${job.name} stopped and restart it; each run records itself with pullboard loop ran ${job.name}`,
      command: null, owner: { role: 'coordinator', who: job.owner }, detail: { job: job.name, every: job.every, lastRun: job.lastRun, owner: job.owner },
    });
  }
  return found;
}
