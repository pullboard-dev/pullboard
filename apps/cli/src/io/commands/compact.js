/** The pullboard compact command: archive the job steps of items finished over 30 days ago and shrink the board file [C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { compactJobSteps } from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { withBoard } from '../entry.js';

/** Megabytes with one decimal, for the one-line summary. */
function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Run `pullboard compact [--dry-run]` and return its exit code.
 * Why: the run telemetry has no retention, so the board file grows without bound; the item and event rows are never
 * touched, and the archived steps stay readable from the archive file beside the board.
 */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest?.length) throw new Refused('USAGE', 'compact takes no arguments', 'pullboard compact [--dry-run] [--json]');
  const ctx = context(io);
  const report = withBoard(ctx, board => compactJobSteps(board.db, { dryRun: values['dry-run'] === true }));
  io.result?.(report);
  const verb = report.dryRun ? 'would archive' : 'archived';
  io.say(`${verb} ${report.rows} job steps of ${report.jobs} jobs finished over ${report.days} days ago (${mb(report.payloadBytes)})`);
  if (!report.dryRun) io.say(`board file ${mb(report.before)} to ${mb(report.after)}${report.vacuumed || !report.rows ? '' : ' (not rewritten: a later open will)'}; archive ${report.archive ? `${report.archive} ${mb(report.archiveBytes)}` : 'none (in-memory board)'}`);
  return 0;
}
