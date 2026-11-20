/** The capacity audit: the agent, runner and jobs-per-runner counts the board data supports, read only [C7,U151]. */
import { flowWindowMinutes } from '../../../../packages/stats/index.js';
import { events } from '../../../../packages/store/index.js';
import { boardRunsReader } from '../../../../packages/store/index.js';
import { context } from './entry.js';
import { withBoardRead } from './entry.js';

const HOUR_MS = 3_600_000;
const STEP_AT = 0.9;
const RULE = 'runners bind when the mean gate jobs in flight per runner reaches one; otherwise the agents bind';

/** A count that is unknown, naming the recorded input it lacks, never a typed default. */
function unknown(missing) { return { value: null, missing }; }

/**
 * The one runner.jobs step the controller would take: one more slot, once the mean gate jobs in flight per runner reaches 90% of the median slots runners reported on their claims.
 * Why: the step is named read only first, so the person sees what the controller would do before it may do it [C7,U151].
 *
 * @param {{ value: number|null }} inFlight - Mean gate jobs in flight per runner.
 * @param {number[]} slots - The job slots each runner reported on its claims.
 * @returns {{ step: {knob: string, from: number, to: number, reason: string}|null, missing?: string[] }}
 */
function runnerJobsStep(inFlight, slots) {
  const reported = slots.filter(count => Number.isSafeInteger(count) && count >= 1).sort((a, b) => a - b);
  const missing = [...(reported.length ? [] : ['reported slots']), ...(inFlight.value === null ? ['jobs per runner'] : [])];
  if (missing.length) return { step: null, missing };
  const mid = reported.length >> 1;
  const from = reported.length % 2 ? reported[mid] : Math.floor((reported[mid - 1] + reported[mid]) / 2);
  if (inFlight.value < STEP_AT * from) return { step: null };
  return { step: { knob: 'runner.jobs', from, to: from + 1, reason: `${inFlight.value.toFixed(3)} gate jobs in flight per runner reached ${STEP_AT * 100}% of the median ${from} reported slots` } };
}

/**
 * Count agents, runners and jobs per runner from recorded claims, landings, runner gate receipts and their durations.
 *
 * Why: capacity is a model over board data, so an input the board never recorded stays unknown and is named [C7,U151].
 *
 * @param {{ claims: {seat: string, at: number}[], slots?: number[], landings: number, runs: {runner: string|null, ms: number|null, at: number}[], fromMs: number, toMs: number }} input
 * @returns {object}
 */
export function auditCapacity({ claims, landings, runs, fromMs, toMs, slots = [] }) {
  const seats = new Set(claims.filter(claim => claim.seat).map(claim => claim.seat));
  const agents = seats.size ? { value: seats.size, basis: 'distinct seats with a recorded claim' } : unknown(['claims']);
  const hosts = new Set(runs.filter(run => run.runner).map(run => run.runner));
  const runners = hosts.size ? { value: hosts.size, basis: 'distinct runners named on gate receipts' } : unknown(['gate receipts naming a runner']);
  const timed = runs.filter(run => run.runner && Number.isFinite(run.ms) && run.ms >= 0);
  const busyMs = timed.reduce((sum, run) => sum + run.ms, 0);
  const windowMs = toMs - fromMs;
  const jobsPerRunner = runners.value === null || timed.length === 0 || windowMs <= 0
    ? unknown([...(runners.value === null ? ['gate receipts naming a runner'] : []), ...(timed.length === 0 ? ['gate receipt durations'] : [])])
    : { value: busyMs / windowMs / runners.value, basis: 'gate receipt busy time over the window, per runner' };
  const missing = [...new Set([agents, runners, jobsPerRunner, ...(landings === 0 ? [unknown(['landings'])] : [])].flatMap(count => count.missing ?? []))];
  const binding = missing.length
    ? { kind: 'unknown', missing }
    : { kind: jobsPerRunner.value >= 1 ? 'runners' : 'agents', rule: RULE, landingsPerAgentHour: landings / agents.value / (windowMs / HOUR_MS) };
  const { step, missing: stepMissing } = runnerJobsStep(jobsPerRunner, slots);
  return { agents, runners, jobsPerRunner, landings, binding, step, ...(stepMissing ? { stepMissing } : {}) };
}

/** The step line the audit prints: the one step it would take, or why it names none; it always says nothing changed or nothing was named. */
export function stepLine(audit) {
  return audit.step ? `step: ${audit.step.knob} ${audit.step.from} -> ${audit.step.to} (${audit.step.reason}); nothing changed` : `step: none${audit.stepMissing ? ` (missing: ${audit.stepMissing.join(', ')})` : ''}`;
}

/**
 * The job slots each runner reported on its claims in the window: the largest `jobs` on any claimed step, one number per runner.
 * Why: a runner declares its slots only on its claim, so the claimed step is the one place the board records them [C7,U151].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The job rows' database, read only.
 * @param {number} fromMs
 * @returns {number[]}
 */
function reportedSlots(db, fromMs) {
  const byRunner = new Map();
  let rows = [];
  try { rows = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_name = 'claimed' AND job_step_at >= ?").all(fromMs); } catch { /* no job table reads as no reported slots */ }
  for (const row of rows) {
    let claim = null;
    try { claim = JSON.parse(row.payload); } catch { continue; }
    if (typeof claim?.runner === 'string' && Number.isSafeInteger(claim.jobs) && claim.jobs >= 1) byRunner.set(claim.runner, Math.max(byRunner.get(claim.runner) ?? 0, claim.jobs));
  }
  return [...byRunner.values()];
}

/** Read the board once and print the audit; nothing is written to the board or to any machine setting. */
export async function runAudit(io, values, gateRuns) {
  const ctx = context(io);
  const toMs = ctx.clock.now().getTime();
  const fromMs = toMs - flowWindowMinutes(values.window ?? '14d') * 60_000;
  const from = new Date(fromMs).toISOString();
  const input = withBoardRead(ctx, board => {
    const slots = reportedSlots(boardRunsReader(board, ctx.file)?.db ?? board.db, fromMs);
    const rows = events(board, { since: from, kinds: ['claim', 'merged'] });
    const runs = gateRuns(board).map(run => ({ runner: run.runner?.id ?? (typeof run.runner === 'string' ? run.runner : null), ms: run.durationMs ?? null, at: Date.parse(run.finishedAt ?? run.at ?? '') }))
      .filter(run => Number.isNaN(run.at) || run.at >= fromMs);
    return { claims: rows.filter(row => row.event_kind === 'claim').map(row => ({ seat: row.event_by, at: Date.parse(row.event_at) })),
      landings: rows.filter(row => row.event_kind === 'merged').length, runs, slots, fromMs, toMs };
  });
  const audit = auditCapacity(input);
  io.result?.({ audit });
  const show = (name, count) => io.say(`${name}: ${count.value === null ? `unknown (missing: ${count.missing.join(', ')})` : `${count.value}`}`);
  show('agents', audit.agents); show('runners', audit.runners);
  show('jobs per runner', audit.jobsPerRunner.value === null ? audit.jobsPerRunner : { value: audit.jobsPerRunner.value.toFixed(3) });
  io.say(`binding constraint: ${audit.binding.kind}${audit.binding.missing ? ` (missing: ${audit.binding.missing.join(', ')})` : ` (${audit.binding.rule})`}`);
  io.say(stepLine(audit));
  return 0;
}
