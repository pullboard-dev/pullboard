/** `pullboard stats runners`: measurement of the runner fleet, read-only over the job tables [C7]. */
import {
  HEALTH_PAYLOAD_STEPS,
  HEALTH_STEP_NAMES,
  flowWindowMinutes,
  readRunnerJobs,
  runnerHealth,
  runnerHealthLines,
} from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { withBoard } from '../../entry.js';

/** Parse an ISO UTC instant, refusing anything else. */
function instant(value, flag) {
  const ms = Date.parse(String(value));
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(String(value)) || !Number.isFinite(ms)) throw new Refused('USAGE', `${flag} takes an ISO UTC time, for example ${flag} 2026-11-12T10:00:00Z`);
  return ms;
}

/**
 * Run `pullboard stats runners` and return its exit code: with --health, run time per runner and job kind plus runner health.
 *
 * Why: slow or flaky hosts show in the board's own job steps, so capacity is measured, not assumed.
 */
export function runRunners(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare || !values.health) {
    throw new Refused('USAGE', 'show run time per runner and runner health with pullboard stats runners --health [--window 24h] [--until <ISO time>] [--json]');
  }
  const until = values.until === undefined ? ctx.clock.now().getTime() : instant(values.until, '--until');
  const from = until - flowWindowMinutes(values.window ?? '24h') * 60_000;
  const jobs = withBoard(ctx, board => readRunnerJobs(board.db, { from, until, steps: HEALTH_STEP_NAMES, payloads: HEALTH_PAYLOAD_STEPS }));
  const health = runnerHealth(jobs);
  io.result?.({ runners: { health } });
  for (const line of runnerHealthLines(health)) io.say(line);
  return 0;
}
