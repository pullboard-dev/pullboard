/** Run time per job kind per runner, and runner health from claim, receipt and lost steps [C7]. */
import { nearestRank } from './rank.js';

/** Steps the health view reads. */
export const HEALTH_STEP_NAMES = ['claimed', 'receipt', 'running', 'result', 'lost'];
/** Steps whose payload names the runner. */
export const HEALTH_PAYLOAD_STEPS = ['claimed', 'result'];
/** Two runner events further apart than this end an up span: the runner showed no work for that long. */
export const UP_GAP_MS = 15 * 60_000;
/** Where a test run that names no runner executed: the machine that queued it. */
const LOCAL = 'local';

/**
 * Group sorted event times into spans, joining times no further apart than `gapMs`.
 *
 * @param {number[]} times - epoch ms
 * @param {number} gapMs
 * @returns {{from: number, to: number}[]}
 */
function spansOf(times, gapMs) {
  const spans = [];
  for (const time of [...times].sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && time - last.to <= gapMs) last.to = time;
    else spans.push({ from: time, to: time });
  }
  return spans;
}

/**
 * Run time per runner and job kind, and per runner its up spans, lost leases, retries and re-placed jobs.
 *
 * A claim is one attempt: its run time is the receipt of the same attempt minus the claim. A claim after the first on
 * a job is a retry, counted to the runner that took it; when that runner differs from the one before, the job was
 * re-placed. A claim with no receipt, followed by another claim or by a `lost` step, is a lost lease, counted to the
 * runner that held it. A test run records no claim: it runs from `running` to `result` on the runner its result names,
 * or on `local`. An up span is a stretch of a runner's claims and receipts with no gap over `gapMs`; the time between
 * spans is down time, inferred from silence because the board records no heartbeat per runner.
 *
 * @param {{id: string, kind: string, steps: {name: string, seq: number, at: number, payload?: any}[]}[]} jobs
 * @param {{gapMs?: number}} [options]
 * @returns {{gapMs: number, runtimes: object[], runners: object[]}}
 */
export function runnerHealth(jobs, { gapMs = UP_GAP_MS } = {}) {
  const runs = new Map();
  const seen = new Map();
  const touch = (runner) => {
    if (!seen.has(runner)) seen.set(runner, { runner, runs: 0, retries: 0, replaced: 0, lost: 0, times: [] });
    return seen.get(runner);
  };
  const addRun = (runner, kind, ms) => {
    const key = `${runner}\n${kind}`;
    if (!runs.has(key)) runs.set(key, { runner, kind, times: [] });
    runs.get(key).times.push(ms);
  };
  for (const job of jobs) {
    const claims = job.steps.filter(step => step.name === 'claimed').sort((a, b) => a.seq - b.seq || a.at - b.at);
    const lostAt = job.steps.filter(step => step.name === 'lost').map(step => step.at);
    claims.forEach((claim, index) => {
      const runner = claim.payload?.runner ?? 'unknown';
      const row = touch(runner);
      row.times.push(claim.at);
      if (index > 0) {
        row.retries += 1;
        if ((claims[index - 1].payload?.runner ?? 'unknown') !== runner) row.replaced += 1;
      }
      const receipt = job.steps.find(step => step.name === 'receipt' && step.seq === claim.seq);
      if (receipt) {
        row.runs += 1;
        row.times.push(receipt.at);
        addRun(runner, job.kind, receipt.at - claim.at);
      } else if (index < claims.length - 1 || lostAt.some(at => at >= claim.at)) row.lost += 1;
    });
    const running = job.steps.find(step => step.name === 'running');
    const result = job.steps.find(step => step.name === 'result');
    if (!claims.length && running) {
      const runner = result?.payload?.runner ?? LOCAL;
      const row = touch(runner);
      row.times.push(running.at);
      if (result) { row.runs += 1; row.times.push(result.at); addRun(runner, job.kind, result.at - running.at); }
      else if (lostAt.length) row.lost += 1;
    }
  }
  const iso = ms => new Date(ms).toISOString();
  return {
    gapMs,
    runtimes: [...runs.values()].map(({ runner, kind, times }) => {
      const sorted = times.sort((a, b) => a - b);
      return { runner, kind, count: sorted.length, p50Ms: nearestRank(sorted, 0.5), p90Ms: nearestRank(sorted, 0.9) };
    }).sort((a, b) => a.runner.localeCompare(b.runner) || a.kind.localeCompare(b.kind)),
    runners: [...seen.values()].map(({ times, ...row }) => {
      const spans = spansOf(times, gapMs);
      return { ...row, upSpans: spans.map(span => ({ from: iso(span.from), to: iso(span.to) })),
        downMs: spans.slice(1).reduce((sum, span, index) => sum + span.from - spans[index].to, 0) };
    }).sort((a, b) => a.runner.localeCompare(b.runner)),
  };
}

/** Human lines for the health report. */
export function runnerHealthLines(report) {
  const seconds = value => `${(value / 1000).toFixed(1)}s`;
  const lines = ['runner run time per job kind'];
  for (const row of report.runtimes) lines.push(`${row.runner} ${row.kind}: ${row.count} runs, p50 ${seconds(row.p50Ms)} p90 ${seconds(row.p90Ms)}`);
  lines.push('runner health');
  for (const row of report.runners) lines.push(`${row.runner}: ${row.runs} runs, ${row.lost} lost leases, ${row.retries} retries, ${row.replaced} re-placed, ${row.upSpans.length} up spans, down ${seconds(row.downMs)}`);
  return lines;
}
