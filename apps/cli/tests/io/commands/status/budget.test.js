/**
 * `pullboard next` on a large board prints each run's time and the median [C7,#5329]. The board is seeded with about
 * 2,500 items and 58,000 shouts; next runs three times in process through the production dispatch. This slice records the
 * figure only: no millisecond bar is asserted yet, so later slices and the parent measure against it.
 */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { largeBoard } from '../../../fixtures/board/large.js';
import { realGitAdapter } from '../../../../../../packages/git/index.js';
import { withGitAdapter } from '../../../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { fileFixtureItem } from '../../../fixtures/testkit.js';

const RUNS = 3;
/**
 * Run `work` with a `git` first on PATH that notes each launch in a file, then runs the real one; returns the count with the result.
 * Why a shim: it sees every git process whichever module or thread starts it.
 */
async function countGitLaunches(box, work) {
  const files = privateFixtureFiles('pullboard-git-count-');
  const before = process.env.PATH;
  const boxBefore = box.env.PATH;
  try {
    files.write('launches', '');
    // The shim notes the launch, restores the original PATH and runs the real git.
    files.write('bin/git', `#!/bin/sh\necho x >> '${join(files.root, 'launches')}'\nPATH='${before}'\nexec git "$@"\n`);
    chmodSync(join(files.root, 'bin/git'), 0o755);
    process.env.PATH = `${join(files.root, 'bin')}${delimiter}${before}`;
    box.env.PATH = process.env.PATH;
    // Real Git, so the shim sees the processes a seat's next starts, whatever adapter the fixture chose.
    const result = await withGitAdapter(realGitAdapter, work);
    return { launches: readFileSync(join(files.root, 'launches'), 'utf8').split('\n').filter(Boolean).length, result };
  } finally {
    process.env.PATH = before;
    if (boxBefore === undefined) delete box.env.PATH; else box.env.PATH = boxBefore;
    rmSync(files.root, { recursive: true, force: true });
  }
}

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
  const launches = [];
  let previous = null;
  for (let run = 0; run < RUNS; run += 1) {
    if (previous) json(await box.runIn(box.web, 'release', String(previous), '--reason', 'OTHER', '--note', 'Next timing sample.', '--no-next', '--json'), 'release');
    const started = performance.now();
    const counted = await countGitLaunches(box, () => box.runIn(box.web, 'next', '--build', '--json'));
    const result = counted.result;
    samples.push(performance.now() - started);
    launches.push(counted.launches);
    assert.equal(result.code, 0, `next exited ${result.code}: ${result.err}${result.out}`);
    const answer = JSON.parse(result.out);
    previous = answer?.item?.item_id ?? answer?.item_id ?? null;
  }
  console.log(`# next on 2,500 items: ${samples.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; median ${median(samples).toFixed(0)} ms`);
  console.log(`# git launches per claiming next: ${launches.join(', ')}`);
  return samples;
}

test('cli.journeys-speed-budget.pullboard-next-runs-three-times-in: clause 1: pullboard next runs three times in process on the 2,500-item board and prints each run in ms [C7,#5329]', async (t) => {
  const samples = await timeNext(largeBoard(t), 'Next sample');
  assert.equal(samples.length, RUNS);
  samples.forEach(ms => assert.ok(ms > 0, `a run took ${ms} ms`));
});

test('cli.journeys-speed-budget.the-median-of-the-three-timed: clause 2: the median of the three timed runs is a positive number, with no millisecond bar asserted yet [C7,#5329]', async (t) => {
  const middle = median(await timeNext(largeBoard(t), 'Median sample'));
  assert.ok(Number.isFinite(middle) && middle > 0, `median ${middle}`);
});
