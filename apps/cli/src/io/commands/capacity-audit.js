/** pullboard capacity --audit: the agent, runner and jobs-per-runner counts the board data supports, read only [C7,U151]. */
import { flowWindowMinutes } from '../../../../../packages/stats/index.js';
import { events } from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';

const HOUR_MS = 3_600_000;
const RULE = 'runners bind when the mean gate jobs in flight per runner reaches one; otherwise the agents bind';

/** A count that is unknown, naming the recorded input it lacks, never a typed default. */
function unknown(missing) { return { value: null, missing }; }

/**
 * Count agents, runners and jobs per runner from recorded claims, landings, runner gate receipts and their durations.
 *
 * Why: capacity is a model over board data, so an input the board never recorded stays unknown and is named [C7,U151].
 *
 * @param {{ claims: {seat: string, at: number}[], landings: number, runs: {runner: string|null, ms: number|null, at: number}[], fromMs: number, toMs: number }} input
 * @returns {object}
 */
export function auditCapacity({ claims, landings, runs, fromMs, toMs }) {
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
  return { agents, runners, jobsPerRunner, landings, binding };
}

/** Read the board once and print the audit; nothing is written to the board or to any machine setting. */
export async function runAudit(io, values, gateRuns) {
  const ctx = context(io);
  const toMs = ctx.clock.now().getTime();
  const fromMs = toMs - flowWindowMinutes(values.window ?? '14d') * 60_000;
  const from = new Date(fromMs).toISOString();
  const input = withBoardRead(ctx, board => {
    const rows = events(board, { since: from, kinds: ['claim', 'merged'] });
    const runs = gateRuns(board).map(run => ({ runner: run.runner?.id ?? (typeof run.runner === 'string' ? run.runner : null), ms: run.durationMs ?? null, at: Date.parse(run.finishedAt ?? run.at ?? '') }))
      .filter(run => Number.isNaN(run.at) || run.at >= fromMs);
    return { claims: rows.filter(row => row.event_kind === 'claim').map(row => ({ seat: row.event_by, at: Date.parse(row.event_at) })),
      landings: rows.filter(row => row.event_kind === 'merged').length, runs, fromMs, toMs };
  });
  const audit = auditCapacity(input);
  io.result?.({ audit });
  const show = (name, count) => io.say(`${name}: ${count.value === null ? `unknown (missing: ${count.missing.join(', ')})` : `${count.value}`}`);
  show('agents', audit.agents); show('runners', audit.runners);
  show('jobs per runner', audit.jobsPerRunner.value === null ? audit.jobsPerRunner : { value: audit.jobsPerRunner.value.toFixed(3) });
  io.say(`binding constraint: ${audit.binding.kind}${audit.binding.missing ? ` (missing: ${audit.binding.missing.join(', ')})` : ` (${audit.binding.rule})`}`);
  return 0;
}
