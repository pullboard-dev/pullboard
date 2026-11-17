/**
 * The claim median on the 2,500-item board is measured in process through the production dispatch and held under its
 * bar [C7,#5331]. The board is seeded with about 2,500 items and 58,000 shouts; five claims are timed, each previous
 * claim handed back untimed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const RUNS = 5;
/** The most the claim median may be, in ms (the measured median rounded up when over 170; run id on #10278). */
const BAR_MS = 170;
/** The median measured on a runner, in ms, written in the case title. */
const MEASURED_MS = 0;

/** The middle of the samples. */
function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

/** The JSON a setup command printed, requiring it to have worked. */
function json(result, what) {
  assert.equal(result.code, 0, `${what}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

test(`clause 1: the claim median on the 2,500-item board is ${MEASURED_MS} ms, under ${BAR_MS} ms [C7,#5331]`, async (t) => {
  const box = largeBoard(t);
  const ids = [];
  // Undiagnosed items keep their strong route, so the seat may claim them.
  for (let n = 0; n < RUNS; n += 1) ids.push(fileFixtureItem(box, box.repo, { lane: 'web', title: `Claim sample ${n}`, diagnose: false, args: ['--specs', 'G1'] }).item_id);
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    if (run > 0) json(await box.runIn(box.web, 'release', String(ids[run - 1]), '--reason', 'OTHER', '--note', 'Claim timing sample.', '--no-next', '--json'), 'release');
    const started = performance.now();
    const result = await box.runIn(box.web, 'claim', String(ids[run]), '--json');
    samples.push(performance.now() - started);
    json(result, 'claim');
  }
  console.log(`# claim on 2,500 items: ${samples.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; median ${median(samples).toFixed(0)} ms`);
  assert.ok(median(samples) < BAR_MS, `the claim median was ${median(samples).toFixed(0)} ms, over the ${BAR_MS} ms bar (runs: ${samples.map(ms => ms.toFixed(0)).join(', ')})`);
});
