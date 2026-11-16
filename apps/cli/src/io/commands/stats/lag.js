/** `pullboard stats runners --lag`: how soon each main commit gets a full-suite result, read-only over the board [C7]. */
import { boardRunsReader } from '../../../../../../packages/store/index.js';
import {
  MAIN_TEST_KIND,
  flowWindowMinutes,
  mainLag,
  mainLagLines,
  readMainLandings,
  readRunnerJobs,
} from '../../../../../../packages/stats/index.js';
import { tryGit } from '../../../../../../packages/git/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { withBoard } from '../../entry.js';

/** Parse an ISO UTC instant, refusing anything else. */
function instant(value, flag) {
  const ms = Date.parse(String(value));
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(String(value)) || !Number.isFinite(ms)) throw new Refused('USAGE', `${flag} takes an ISO UTC time, for example ${flag} 2026-11-12T10:00:00Z`);
  return ms;
}

/** The tree a commit holds, or null when the checkout no longer has the commit. */
function treeOf(root, sha) {
  const read = tryGit(root, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
  return read.status === 0 && read.stdout ? read.stdout : null;
}

/**
 * Run `pullboard stats runners --lag` and return its exit code: the time from each main commit landing to its first full-suite result.
 *
 * Why: a red main is only as cheap as it is quick to notice, and main-test results are keyed by tree, so each landing is read at its tree.
 */
export function runLag(io, ctx, { second, rest, values }) {
  if (second !== undefined || rest?.length || values.since !== undefined || values.compare) {
    throw new Refused('USAGE', 'show how soon main commits get a full-suite result with pullboard stats runners --lag [--window 24h] [--until <ISO time>] [--json]');
  }
  const until = values.until === undefined ? ctx.clock.now().getTime() : instant(values.until, '--until');
  const from = until - flowWindowMinutes(values.window ?? '24h') * 60_000;
  const { landings, jobs } = withBoard(ctx, board => ({
    landings: readMainLandings(board.db, { from, until }),
    // A result may arrive after the window closes, so jobs are read to the end of time.
    jobs: readRunnerJobs(board.db, { from, until: Number.MAX_SAFE_INTEGER, steps: ['receipt'], payloads: ['receipt'], kinds: [MAIN_TEST_KIND], runs: boardRunsReader(board, ctx.file) }),
  }));
  const results = jobs.flatMap(job => job.steps.filter(step => step.name === 'receipt' && typeof step.payload?.tree === 'string')
    .map(step => ({ tree: step.payload.tree, at: step.at, verdict: step.payload.verdict ?? 'unknown' })));
  const lag = mainLag(landings.map(landing => ({ ...landing, tree: treeOf(ctx.info.root, landing.sha) })), results);
  io.result?.({ runners: { mainLag: lag } });
  for (const line of mainLagLines(lag)) io.say(line);
  return 0;
}
