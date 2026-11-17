/**
 * `pullboard next` on a large board prints each run's time and the median [C7,#5329]. The board is seeded with about
 * 2,500 items and 58,000 shouts; next runs three times in process through the production dispatch. This slice records the
 * figure only: no millisecond bar is asserted yet, so later slices and the parent measure against it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const RUNS = 3;

/** The middle of the samples. */
function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

/** The JSON a setup command printed, requiring it to have worked. */
function json(result, what) {
  assert.equal(result.code, 0, `${what}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

/** File three items, then time `pullboard next --build` three times in process, handing each claim back untimed. */
async function timeNext(box, title) {
  // Undiagnosed items keep their strong route, so the seat is offered one.
  for (let n = 0; n < RUNS; n += 1) fileFixtureItem(box, box.repo, { lane: 'web', title: `${title} ${n}`, diagnose: false, args: ['--specs', 'G1'] });
  const samples = [];
  let previous = null;
  for (let run = 0; run < RUNS; run += 1) {
    if (previous) json(await box.runIn(box.web, 'release', String(previous), '--reason', 'OTHER', '--note', 'Next timing sample.', '--no-next', '--json'), 'release');
    const started = performance.now();
    const result = await box.runIn(box.web, 'next', '--build', '--json');
    samples.push(performance.now() - started);
    assert.equal(result.code, 0, `next exited ${result.code}: ${result.err}${result.out}`);
    const answer = JSON.parse(result.out);
    previous = answer?.item?.item_id ?? answer?.item_id ?? null;
  }
  console.log(`# next on 2,500 items: ${samples.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; median ${median(samples).toFixed(0)} ms`);
  return samples;
}

test('clause 1: pullboard next runs three times in process on the 2,500-item board and prints each run in ms [C7,#5329]', async (t) => {
  const samples = await timeNext(largeBoard(t), 'Next sample');
  assert.equal(samples.length, RUNS);
  samples.forEach(ms => assert.ok(ms > 0, `a run took ${ms} ms`));
});

test('clause 2: the median of the three timed runs is a positive number, with no millisecond bar asserted yet [C7,#5329]', async (t) => {
  const middle = median(await timeNext(largeBoard(t), 'Median sample'));
  assert.ok(Number.isFinite(middle) && middle > 0, `median ${middle}`);
});
