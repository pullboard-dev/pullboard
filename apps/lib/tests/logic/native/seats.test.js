/** A board scale test measures writer load and command latency at 1,000 simulated seats [C7,#3008]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { loadavg } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../index.js';
import { repositoryBoardFile } from '../../../../cli/tests/fixtures/board/submit.js';
import { submitFixture } from '../../../../cli/tests/fixtures/board/submit.js';
import { requireFixtureReviewFamilies } from '../../../../cli/tests/fixtures/review/family.js';

const COMMIT = 'a'.repeat(40);
const LANES = ['core', 'coordinator'];
const SEATS = 1000;
/** Measurement rounds a loaded host may use before the bars judge the last one. */
const ROUNDS = 3;
/** Today's per-seat rates, per hour, from the board's own write log (audit round 11: about 130 writes per seat per hour). */
const RATES = { heartbeat: 60, next: 120, shout: 100, claim: 10, submit: 10, verdict: 10 };
/** The scale bars: the writer's busy share and the p99 of `next`. */
const MAX_BUSY_SHARE = 0.5;
const MAX_NEXT_P99_MS = 200;

/** The percentile of a list of timings, by rank. */
function percentile(values, share) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * Turn per-command timings into the scale report: the writer's busy share at SEATS seats and p50/p99 latency per command.
 * Busy share is the seconds of board-write time the seats ask for in one second: rate per second times mean write time.
 * Heartbeats and `next` do not take the board write lock, so they add latency rows but no busy time.
 *
 * @param {Record<string, number[]>} timings - Milliseconds per sampled run of each command.
 * @param {{ seats?: number }} [options]
 * @returns {{ busyShare: number, commands: Record<string, { p50: number, p99: number, perSecond: number }> }}
 */
export function scaleReport(timings, { seats = SEATS } = {}) {
  let busy = 0;
  const commands = {};
  for (const [name, perHour] of Object.entries(RATES)) {
    const samples = timings[name] ?? [];
    const perSecond = seats * perHour / 3600;
    commands[name] = { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99), perSecond };
    if (!['heartbeat', 'next'].includes(name)) busy += perSecond * samples.reduce((sum, ms) => sum + ms, 0) / samples.length / 1000;
  }
  return { busyShare: busy, commands };
}

/** The refusals the scale bars name; an empty list means the board holds at this seat count. */
export function scaleProblems(report) {
  const problems = [];
  if (report.busyShare > MAX_BUSY_SHARE) problems.push(`writer busy share ${(report.busyShare * 100).toFixed(1)}% is over ${MAX_BUSY_SHARE * 100}%`);
  if (report.commands.next.p99 > MAX_NEXT_P99_MS) problems.push(`p99 next ${report.commands.next.p99.toFixed(1)} ms is over ${MAX_NEXT_P99_MS} ms`);
  return problems;
}

/** Run `action` and return how long it took in milliseconds. */
function timed(action) {
  const started = performance.now();
  action();
  return performance.now() - started;
}

test('[C7,#3008] clause 1: 1,000 simulated seats drive heartbeat, next, claim, submit and verdict and report busy share and p50/p99 per command', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-scale-'));
  const board = openBoard(repositoryBoardFile(directory));
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builders = [];
  const reviewers = [];
  for (let n = 0; n < SEATS / 2; n++) {
    builders.push(store.register(board, { lane: 'core', path: `/builder-${n}`, family: 'Fixture Scale Builder Vendor', route: 'mid' }));
    reviewers.push(store.register(board, { lane: 'core', path: `/reviewer-${n}`, family: 'Fixture Scale Reviewer Vendor', route: 'mid' }));
  }
  requireFixtureReviewFamilies(board);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM agent WHERE agent_lane = 'core'").get().n, SEATS);
  // A copy-sized board: a few hundred open items besides the ones the seats move.
  const filler = Array.from({ length: 300 }, (_, n) => store.addItem(board, { by: 'coordinator', lane: 'core', title: `open ${n}`, criterion: 'prove', specIds: ['C7'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }));
  assert.equal(filler.length, 300);
  // Three sets of items the seats move, one per measurement round (see the remeasure note below).
  const movedSets = Array.from({ length: ROUNDS }, (_, round) => Array.from({ length: 30 }, (_, n) => store.addItem(board, { by: 'coordinator', lane: 'core', title: `moved ${round}.${n}`, criterion: 'prove', specIds: ['C7'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' })));
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } } }), digest: 'digest:bar' });

  /** One full measurement: the three read-and-shout loops, then 30 items moved from claim to verified. */
  const measureRound = moved => {
    const timings = { heartbeat: [], next: [], shout: [], claim: [], submit: [], verdict: [] };
    for (let n = 0; n < 300; n++) {
      const seat = builders[n % builders.length];
      timings.heartbeat.push(timed(() => store.heartbeatSeat(board, seat)));
      timings.next.push(timed(() => store.nextFor(board, { agentId: seat, lane: 'core' })));
      timings.shout.push(timed(() => store.shout(board, { from: seat, to: 'core', lanes: LANES, text: `seat ${n}` })));
    }
    moved.forEach((id, n) => {
      timings.claim.push(timed(() => store.claim(board, id, { agentId: builders[n], lane: 'core', leaseMs: 7_200_000, freeze })));
      timings.submit.push(timed(() => submitFixture(board, id, { agentId: builders[n], commit: COMMIT, tree: COMMIT })));
      timings.verdict.push(timed(() => store.verify(board, id, { agentId: reviewers[n], head: COMMIT, digest: 'digest:bar', policy: 'any', note: 'proof', decision: 'ACCEPT' })));
    });
    for (const id of moved) assert.equal(store.getItem(board, id).item_status, 'verified');
    return scaleReport(timings);
  };
  // The scale bars are unchanged. A round that misses them while the host's one-minute load exceeds half its cores measured
  // the machine, not the board, so it is measured again on fresh items, at most twice more; a real slowdown misses every round [C7,#3008].
  let report;
  for (const moved of movedSets) {
    report = measureRound(moved);
    if (scaleProblems(report).length === 0 || loadavg()[0] <= cpus().length / 2) break;
  }
  for (const name of Object.keys(RATES)) {
    assert.ok(Number.isFinite(report.commands[name].p50) && Number.isFinite(report.commands[name].p99), `${name} has p50 and p99`);
  }
  assert.ok(Number.isFinite(report.busyShare));
  const rows = Object.entries(report.commands).map(([name, row]) => `${name} p50 ${row.p50.toFixed(2)} ms p99 ${row.p99.toFixed(2)} ms`);
  console.log(`board scale at ${SEATS} seats: writer busy ${(report.busyShare * 100).toFixed(2)}%; ${rows.join('; ')}`);
  // clause 2 on the measured run: the board holds at 1,000 seats.
  assert.deepEqual(scaleProblems(report), []);
});

test('[C7,#3008] clause 2: the scale test fails when writer busy share passes 50% or p99 next passes 200 ms', () => {
  const quick = Array.from({ length: 100 }, () => 1);
  const base = { heartbeat: quick, next: quick, shout: quick, claim: quick, submit: quick, verdict: quick };
  assert.deepEqual(scaleProblems(scaleReport(base)), [], 'a fast board passes');
  const busy = scaleProblems(scaleReport({ ...base, shout: Array.from({ length: 100 }, () => 40) }));
  assert.equal(busy.length, 1);
  assert.match(busy[0], /writer busy share .* is over 50%/u);
  const slowNext = scaleProblems(scaleReport({ ...base, next: [...quick.slice(1), 250] }));
  assert.equal(slowNext.length, 1);
  assert.match(slowNext[0], /p99 next 250\.0 ms is over 200 ms/u);
});
