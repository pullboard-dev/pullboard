/** The read-only gate health report: where queued submit gates spent their time in a window [C7]. */
import {
  context,
  withBoardRead,
} from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { gateHealthLines } from '../../../../../packages/gate/index.js';
import { gateHealthReport } from '../../../../../packages/gate/index.js';
import { landingHealthLines } from '../../../../../packages/landing/index.js';
import { landingHealthReport } from '../../../../../packages/landing/index.js';

/**
 * Milliseconds in a window such as 30m, 2h or 1d.
 *
 * @param {string} value
 * @returns {number}
 */
export function gateHealthWindowMs(value) {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/u.exec(String(value));
  const ms = match ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] : NaN;
  if (!(ms > 0) || !Number.isFinite(ms)) throw new Refused('USAGE', 'use pullboard gate-health [--since 2h] [--json] with a positive window, for example --since 30m, 2h or 1d');
  return ms;
}

/**
 * Print the gate count, total percentiles, time per phase, failure causes and slowest gates, then the landings'
 * accept-to-merged times and time per landing step, recording no move.
 */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || Object.keys(values).some(key => !['json', 'since'].includes(key))) {
    throw new Refused('USAGE', 'pullboard gate-health [--since 2h] [--json] reports where gate and landing time went');
  }
  const window = typeof values.since === 'string' ? values.since : '2h';
  const span = gateHealthWindowMs(window);
  const ctx = context(io);
  const now = ctx.clock.now().getTime();
  const { report, landing } = withBoardRead(ctx, board => ({ report: gateHealthReport(board.db, { commonDir: ctx.info.commonDir, since: now - span, now }),
    landing: landingHealthReport(board.db, { commonDir: ctx.info.commonDir, since: now - span, now }) }));
  io.result?.({ report, landing });
  for (const line of [...gateHealthLines(report, window), ...landingHealthLines(landing)]) io.say(line);
  return 0;
}
