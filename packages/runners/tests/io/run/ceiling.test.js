/** A gate run with no timeout of its own is stopped as hung at its ceiling, never left to run for hours [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUN_CEILING_MS } from '../../../src/io/dispatch.js';
import { runCeilingMs } from '../../../src/io/dispatch.js';

test('a gate item check or proof with no timeout of its own gets the 20-minute run ceiling; landings, trusted checks and main comparisons keep their own budgets [C7]', () => {
  // #2828 (9 Nov): an item check's hanging test held its gate 55 minutes; the same check hung 9 and 11 hours elsewhere.
  assert.equal(RUN_CEILING_MS, 20 * 60_000);
  assert.equal(runCeilingMs({ kind: 'submit' }, {}), RUN_CEILING_MS, 'a submit run with no timeout is bounded');
  assert.equal(runCeilingMs({ kind: 'review' }, {}), RUN_CEILING_MS, 'a review check is bounded');
  assert.equal(runCeilingMs({ kind: 'submit', timeoutMs: 60_000 }, {}), null, 'a run with its own timeout keeps it');
  assert.equal(runCeilingMs({ kind: 'private', trustedMode: { timeoutMs: 60_000 } }, {}), null, 'a trusted check keeps its own timeout');
  assert.equal(runCeilingMs({ kind: 'land', landing: true }, {}), null, 'a landing keeps its own budget');
  assert.equal(runCeilingMs({ kind: 'main-red' }, {}), null, 'a main comparison may run longer');
  assert.equal(runCeilingMs({ kind: 'submit' }, { PULLBOARD_RUNNER_RUN_CEILING_MS: '300000' }), 300_000, 'the setting overrides the ceiling');
  assert.equal(runCeilingMs({ kind: 'submit' }, { PULLBOARD_RUNNER_RUN_CEILING_MS: '0' }), null, 'zero turns it off');
});
