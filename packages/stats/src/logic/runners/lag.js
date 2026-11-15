/** Main check lag: from a commit landing on main to its first full-suite result, and to its first red [C7]. */
import { nearestRank } from './rank.js';

/** The job kind that runs one file of the full suite on a main commit. */
export const MAIN_TEST_KIND = 'main-test';

/**
 * Lag per main commit, and a summary.
 *
 * A main-test job is keyed by main's tree, one test file per job, so a landing is matched to results by its tree. The
 * first full-suite result of a commit is the earliest `main-test` receipt recorded on its tree at or after the landing
 * (each receipt is one file of the suite); a commit whose first receipt is red has its red noticed at that moment,
 * otherwise at its earliest red receipt. A landed commit with no receipt is pending: it has no lag yet and is counted,
 * not guessed.
 *
 * @param {{sha: string, tree: string|null, at: number}[]} landings - main-moved events with the commit's tree, epoch ms
 * @param {{tree: string, at: number, verdict: string}[]} results - main-test receipts
 * @returns {{commits: object[], summary: object}}
 */
export function mainLag(landings, results) {
  const bySha = new Map();
  for (const landing of landings) if (!bySha.has(landing.sha) || landing.at < bySha.get(landing.sha).at) bySha.set(landing.sha, landing);
  const iso = ms => ms === null ? null : new Date(ms).toISOString();
  const commits = [...bySha.values()].sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha)).map(({ sha, tree, at: landedAt }) => {
    const own = results.filter(result => tree !== null && result.tree === tree && result.at >= landedAt).sort((a, b) => a.at - b.at);
    const first = own[0]?.at ?? null;
    const red = own.find(result => result.verdict === 'red')?.at ?? null;
    return { sha, landedAt: iso(landedAt), firstResultAt: iso(first), lagMs: first === null ? null : first - landedAt,
      firstResult: own[0]?.verdict ?? null, firstRedAt: iso(red), redLagMs: red === null ? null : red - landedAt };
  });
  const lags = commits.filter(row => row.lagMs !== null).map(row => row.lagMs).sort((a, b) => a - b);
  const reds = commits.filter(row => row.redLagMs !== null).map(row => row.redLagMs).sort((a, b) => a - b);
  return { commits, summary: { landed: commits.length, measured: lags.length, pending: commits.length - lags.length,
    p50Ms: nearestRank(lags, 0.5), p90Ms: nearestRank(lags, 0.9), maxMs: lags.length ? lags.at(-1) : null,
    reds: reds.length, redP50Ms: nearestRank(reds, 0.5), redMaxMs: reds.length ? reds.at(-1) : null } };
}

/** Human lines for the main lag report. */
export function mainLagLines(report) {
  const seconds = value => value === null ? 'unmeasured' : `${(value / 1000).toFixed(1)}s`;
  const { summary } = report;
  const lines = [`main check lag: ${summary.landed} landed, ${summary.measured} with a result, ${summary.pending} pending; p50 ${seconds(summary.p50Ms)} p90 ${seconds(summary.p90Ms)} max ${seconds(summary.maxMs)}`,
    `red mains: ${summary.reds}; first red recorded after p50 ${seconds(summary.redP50Ms)} max ${seconds(summary.redMaxMs)}`];
  for (const row of report.commits) lines.push(`${row.sha.slice(0, 10)} landed ${row.landedAt}: result after ${seconds(row.lagMs)}${row.firstRedAt ? `, red recorded after ${seconds(row.redLagMs)}` : ''}`);
  return lines;
}
