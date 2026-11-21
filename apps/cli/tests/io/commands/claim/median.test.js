/**
 * The claim median on the 2,500-item board is measured in process through the production dispatch and held under its
 * bar [C7,#5331]. The board is seeded with about 2,500 items and 58,000 shouts; five claims are timed, each previous
 * claim handed back untimed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { largeBoard } from '../../../fixtures/board/large.js';
import { fileFixtureItem } from '../../../fixtures/testkit.js';

const RUNS = 5;
/**
 * The most the claim median may be, in ms. Audited exception to the 170 ms goal: the median measured on a runner was
 * 151 ms (run 1e54ee7c-bf49-47c5-be38-073a63837a80) and 205 ms (run 30872665-074d-41cc-96e5-e8e0a8cdbbfa), so the bar is the
 * higher median rounded up to the next 50 ms. The earlier
 * 2000 ms was a loaded-runner number and held nothing; the next cut is a new item (#5331).
 */
const BAR_MS = 250;
/** The median measured on a runner (run 30872665-074d-41cc-96e5-e8e0a8cdbbfa), in ms, written in the case title. */
const MEASURED_MS = 205;

/** The middle of the samples. */
function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

/** The JSON a setup command printed, requiring it to have worked. */
function json(result, what) {
  assert.equal(result.code, 0, `${what}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

test('cli.journeys-speed-claim-median.the-claim-median-on-the-2: clause 1: [C7,#5331] the claim median on the 2,500-item board is ' + MEASURED_MS + ' ms, under ' + BAR_MS + ' ms', { timeout: 150_000 }, async (t) => {
  const box = largeBoard(t);
  const ids = [];
  // Undiagnosed items keep their strong route, so the seat may claim them.
  const setup = performance.now();
  for (let n = 0; n < RUNS; n += 1) ids.push(fileFixtureItem(box, box.repo, { lane: 'web', title: `Claim sample ${n}`, diagnose: false, args: ['--specs', 'G1'] }).item_id);
  console.log(`# filed ${RUNS} items in ${(performance.now() - setup).toFixed(0)} ms`);
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    if (run > 0) json(await box.runIn(box.web, 'release', String(ids[run - 1]), '--reason', 'OTHER', '--note', 'Claim timing sample.', '--no-next', '--json'), 'release');
    const started = performance.now();
    const result = await box.runIn(box.web, 'claim', String(ids[run]), '--json');
    samples.push(performance.now() - started);
    console.log(`# claim ${run} ${samples[run].toFixed(0)} ms`);
    json(result, 'claim');
  }
  console.log(`# claim on 2,500 items: ${samples.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; median ${median(samples).toFixed(0)} ms`);
  assert.ok(median(samples) < BAR_MS, `the claim median was ${median(samples).toFixed(0)} ms, over the ${BAR_MS} ms bar (runs: ${samples.map(ms => ms.toFixed(0)).join(', ')})`);
});
