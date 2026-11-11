// pullboard: browser
/** @pullboard-test-gui */
/** The phone's first-paint budget is judged by the page, not by a loaded test runner [H5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findChromeExecutable } from '../../../../tests/fixtures/relay/browser.js';
import {
  assertFirstPaint,
  cpuStandIn,
  openOnPhone,
  paintWithinBudget,
  thirtyThousandBoard,
} from '../../../../tests/fixtures/relay/sealed-client.js';

test("the phone's first-paint budget is judged by the page, not by a loaded test runner [H5]", {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  // The judgement itself, at its boundaries: 3 s on a quiet machine, the 30 s page-clock fallback on a busy one.
  const quiet = { after: 1, cores: 14 };
  const busy = { after: 99, cores: 14 };
  assertFirstPaint(t, { firstBoardPaint: 2_999, loadBefore: 1 }, 'quiet boundary', quiet);
  assert.throws(() => assertFirstPaint(t, { firstBoardPaint: 3_001, loadBefore: 1 }, 'quiet boundary', quiet));
  assertFirstPaint(t, { firstBoardPaint: 29_999, loadBefore: 99 }, 'busy boundary', busy);
  assert.throws(() => assertFirstPaint(t, { firstBoardPaint: 30_001, loadBefore: 99 }, 'busy boundary', busy));
  const board = await thirtyThousandBoard(t);
  const load = cpuStandIn(t);
  const paints = [];
  try {
    for (let run = 0; run < 5; run++) {
      const { chrome, first } = await openOnPhone(t, board);
      assertFirstPaint(t, first, `run ${run + 1}`);
      paints.push(first.firstBoardPaint);
      t.diagnostic(JSON.stringify({ run: run + 1, firstBoardPaintMs: Math.round(first.firstBoardPaint) }));
      await chrome.close();
    }
  } finally { load.stop(); }
  t.diagnostic(JSON.stringify({ cpuStandIn: load.count, loadBefore: Number(load.load.toFixed(1)), firstBoardPaintMs: paints.map(ms => Math.round(ms)) }));
  // A test-only hold on the phone's current-state read really delays the paint past the bar, and the judgement turns red.
  const { chrome, first } = await openOnPhone(t, board, { holdStateMs: 3_500 });
  await chrome.close();
  assert.ok(first.firstBoardPaint >= 3000, `the held state read delays the page's own paint: ${first.firstBoardPaint}`);
  assert.equal(paintWithinBudget(first), false, 'a paint past three seconds fails the bar');
});
