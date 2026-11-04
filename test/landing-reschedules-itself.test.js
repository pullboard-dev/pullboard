/** @pullboard-test-input source-tree */
/** Automatic landing schedules its own next wake while verified items wait [C7,#2898]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LANDING_RETRY_MS, landingRetryAt } from '../apps/cli/src/shell/commands/land.js';

const NOW = Date.parse('2026-11-04T07:00:00.000Z');

test('a blocked or partly landed batch with verified items waiting wakes again one interval later [C7,#2898]', () => {
  assert.equal(landingRetryAt({ batch: null, landed: [], blocked: [{ id: 7, code: 'LAND_PLAN_MISSING' }], waiting: true }, NOW),
    new Date(NOW + LANDING_RETRY_MS).toISOString());
  assert.equal(landingRetryAt({ landed: [1, 2], waiting: true, retryMs: 600_000 }, NOW), new Date(NOW + 600_000).toISOString(),
    'a configured cadence sets the interval');
  assert.equal(LANDING_RETRY_MS, 300_000, 'the default retry is five minutes, the shortest landing cadence');
});

test('a recorded cadence deferral keeps its own wake time [C7,#2898]', () => {
  assert.equal(landingRetryAt({ deferredUntil: '2026-11-04T07:03:00.000Z', waiting: true }, NOW), '2026-11-04T07:03:00.000Z');
});

test('with no verified item waiting, no wake is scheduled [C7,#2898]', () => {
  assert.equal(landingRetryAt({ landed: [1], waiting: false }, NOW), null);
  assert.equal(landingRetryAt(undefined, NOW), null);
});

test('releasing a verified item hold wakes landing the way an accept does [C7,#2898]', () => {
  const source = readFileSync(new URL('../apps/cli/src/shell/commands/hold.js', import.meta.url), 'utf8');
  assert.match(source, /item_status === 'verified'\) released = ctx/u);
  assert.match(source, /landAfterAcceptance\(released\)/u);
});
