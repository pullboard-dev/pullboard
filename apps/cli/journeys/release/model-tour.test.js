/** Model-free scripted tours [N10,O8]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox } = e2e;

const TOUR_STEPS = [
  '1  The person approved one spec row. The coordinator files it as work.',
  '2  A builder agent gets its own worktree in the app lane and claims the next item. Its criterion freezes.',
  '3  It writes greet(), tests the happy path and submits. Its own gate is green.',
  '4  A second agent checks out exactly that commit and tries the edge the builder skipped.',
  "5  The builder's next session starts from the board, not from memory.",
  '6  It fixes the edge, adds a test that pins it, and submits a new commit.',
  '7  The verifier breaks the fix on purpose, to prove the new test can fail, then restores it and accepts.',
  '8  The lander lands it: a land job merges it onto main. The ledger is the receipt.',
];

/** Return the numbered steps printed by the scripted tour. */
function tourSteps(stdout) {
  return [...stdout.matchAll(/^(\d+)  (.+)$/gmu)].map((match) => `${match[1]}  ${match[2]}`);
}

/** Create private loader fixtures that vary only the production tour module. */
function createTourVariantHarness(box) {
  const moduleUrl = new URL('../../src/io/tour.js', import.meta.url).href;
  const loader = join(box.dir, 'tour-variant-loader.mjs');
  const timerGuard = join(box.dir, 'tour-timer-guard.mjs');
  writeFileSync(loader, `
    /** Load the real tour module with one requested private test variation. */
    export async function load(url, context, nextLoad) {
      const loaded = await nextLoad(url, context);
      if (url !== process.env.PULLBOARD_TOUR_TEST_MODULE) return loaded;
      let source = String(loaded.source);
      if (process.env.PULLBOARD_TOUR_TEST_VARIANT === 'prompt') {
        const marker = '  try {\\n    mkdirSync(repo);';
        const replacement = [
          '  try {',
          "    io.say('Model name?');",
          "    let modelInput = '';",
          '    for await (const chunk of process.stdin) modelInput += chunk;',
          "    if (!modelInput.trim()) throw new TourStopped('model prompt reached EOF');",
          '    mkdirSync(repo);',
        ].join('\\n');
        if (!source.includes(marker)) throw new Error('tour prompt marker not found');
        source = source.replace(marker, replacement);
      } else if (process.env.PULLBOARD_TOUR_TEST_VARIANT === 'sleep') {
        const marker = '    pause(1200 * pace);';
        if (!source.includes(marker)) throw new Error('tour step pause marker not found');
        source = source.replace(marker, '    pause(1);\\n' + marker);
      } else {
        throw new Error('unknown private tour variant');
      }
      return { ...loaded, source };
    }
  `);
  writeFileSync(timerGuard, `
    if (process.argv[2] === 'tour') {
      const originalWait = Atomics.wait;
      /** Turn a production tour pause into a deterministic error, not elapsed time. */
      Atomics.wait = (array, index, value, timeout) => {
        if (timeout > 0) throw new Error('tour timer wait detected');
        return originalWait(array, index, value, timeout);
      };
    }
  `);
  return { loader, moduleUrl, timerGuard };
}

/** Run the real CLI tour with stdin closed and an optional private source variation. */
function runTour(box, harness, variant = '') {
  const activeHarness = harness ?? createTourVariantHarness(box);
  const env = { ...box.env, TMPDIR: box.dir, PULLBOARD_TOUR_TEST_MODULE: activeHarness.moduleUrl };
  delete env.PULLBOARD_MODEL;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  if (variant) env.PULLBOARD_TOUR_TEST_VARIANT = variant;
  const args = ['--import', activeHarness.timerGuard];
  if (variant) args.push('--experimental-loader', activeHarness.loader);
  args.push(BIN, 'tour');
  // Process-level: the tour runs under node --import and --experimental-loader flags, so it stays a child process.
  return runFixtureChild(process.execPath, args, { cwd: box.dir, env, encoding: 'utf8', input: '' });
}

test('cli.journeys-release-model-tour.the-scripted-tour-names-its-model: the scripted tour names its model without PULLBOARD_MODEL [N10,O8]', () => {
  const box = sandbox();
  const result = runTour(box);
  assert.deepEqual(tourSteps(result.stdout), TOUR_STEPS, result.failure ?? result.stdout);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /app-1 \(Scripted\) \$ pullboard next/);
  assert.match(result.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1 \(Scripted\):/);
  assert.match(result.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \(Scripted\) \| review-1 \(Scripted\) \|/);
});
