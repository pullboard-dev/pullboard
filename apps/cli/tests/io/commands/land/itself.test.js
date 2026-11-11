/** @pullboard-test-input source-tree */
/** Automatic landing schedules its own next wake while verified items wait [C7,#2898]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LANDING_RETRY_MS } from '../../../../src/io/commands/land.js';
import { landingRetryAt } from '../../../../src/io/commands/land.js';
import { LANDING_NEXT_BATCH_MS } from '../../../../src/io/commands/land.js';
import { untilBoardFree } from '../../../../src/io/commands/land.js';

const NOW = Date.parse('2026-11-04T07:00:00.000Z');

test('a blocked or partly landed batch with verified items waiting wakes again one interval later [C7,#2898]', () => {
  assert.equal(landingRetryAt({ batch: null, landed: [], blocked: [{ id: 7, code: 'LAND_PLAN_MISSING' }], waiting: true }, NOW),
    new Date(NOW + LANDING_RETRY_MS).toISOString());
  assert.equal(landingRetryAt({ landed: [], blocked: [], waiting: true, retryMs: 600_000 }, NOW), new Date(NOW + 600_000).toISOString(),
    'a configured cadence sets the interval for a run that moved nothing');
  assert.equal(LANDING_RETRY_MS, 30_000, 'the default retry is thirty seconds: a blocked batch never idles the lander for minutes');
});

test('a recorded cadence deferral keeps its own wake time [C7,#2898]', () => {
  assert.equal(landingRetryAt({ deferredUntil: '2026-11-04T07:03:00.000Z', waiting: true }, NOW), '2026-11-04T07:03:00.000Z');
});

test('with no verified item waiting, no wake is scheduled [C7,#2898]', () => {
  assert.equal(landingRetryAt({ landed: [1], waiting: false }, NOW), null);
  assert.equal(landingRetryAt(undefined, NOW), null);
});

test('releasing a verified item hold wakes landing the way an accept does [C7,#2898]', () => {
  const source = readFileSync(new URL('../../../../src/io/commands/hold.js', import.meta.url), 'utf8');
  assert.match(source, /item_status === 'verified'\) released = ctx/u);
  assert.match(source, /landAfterAcceptance\(released\)/u);
});

test('clause 1: a run that landed or reopened items while others wait starts the next batch within seconds [C7]', () => {
  for (const result of [{ landed: [1, 2], waiting: true }, { landed: [], conflicts: [{ id: 3 }], waiting: true }, { landed: [4], waiting: true, retryMs: 600_000 },
    { landed: [], culprits: [{ id: 5 }], waiting: true }, { batch: null, landed: [], reopened: 1, waiting: true }]) {
    assert.equal(landingRetryAt(result, NOW), new Date(NOW + LANDING_NEXT_BATCH_MS).toISOString(), JSON.stringify(result));
  }
  assert.ok(LANDING_NEXT_BATCH_MS <= 5_000);
  assert.equal(landingRetryAt({ landed: [1], waiting: false }, NOW), null, 'nothing waiting still schedules nothing');
});

test('a landing attempt waits out a busy board lock with backoff, and any other refusal still ends it [C7]', async () => {
  const waits = [];
  let calls = 0;
  const busy = Object.assign(new Error('board is busy'), { code: 'BOARD_BUSY' });
  const value = await untilBoardFree(async () => { calls += 1; if (calls < 4) throw busy; return 'landed'; }, { wait: async ms => { waits.push(ms); } });
  assert.equal(value, 'landed');
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
  const other = Object.assign(new Error('refused'), { code: 'FLAKE_RATCHET' });
  await assert.rejects(untilBoardFree(async () => { throw other; }, { wait: async () => assert.fail('no wait') }), { code: 'FLAKE_RATCHET' });
  await assert.rejects(untilBoardFree(async () => { throw busy; }, { wait: async () => {}, maxWaitMs: 10_000 }), { code: 'BOARD_BUSY' }, 'a lock that never frees ends the attempt');
});

test('a BOARD_BUSY on one write mid-batch retries only that write and never redoes the batch [C7]', async () => {
  let gates = 0, attempts = 0;
  const recorded = [];
  const busy = Object.assign(new Error('board is busy'), { code: 'BOARD_BUSY' });
  const write = (operation, value) => untilBoardFree(async () => {
    attempts += 1;
    if (attempts <= 2) throw busy;
    recorded.push([operation, value]);
  }, { wait: async () => {} });
  // One batch: its gate runs once, then its record write meets the busy lock twice before it lands.
  const batch = async () => { gates += 1; await write('recordLandingBatch', 'landed'); return 'landed'; };
  assert.equal(await batch(), 'landed');
  assert.equal(gates, 1, 'the batch gate ran once');
  assert.equal(attempts, 3, 'only the refused write repeated');
  assert.deepEqual(recorded, [['recordLandingBatch', 'landed']]);
  const source = readFileSync(new URL('../../../../src/io/commands/land.js', import.meta.url), 'utf8');
  assert.match(source, /write: \(operation, parameters\) => untilBoardFree\(\(\) => ordered\(ctx, board, operation, parameters\)/u,
    'the landing engine\'s single write port waits out a busy lock');
  assert.doesNotMatch(source, /untilBoardFree\(\(\) => actOn/u, 'the whole landing is never retried');
});

test('progress always wins over a deferral; with nothing moved the deferral stands [C7]', () => {
  const deferredUntil = '2026-11-04T07:03:00.000Z', next = new Date(NOW + LANDING_NEXT_BATCH_MS).toISOString();
  for (const moved of [{ landed: [1] }, { landed: [], culprits: [{ id: 2 }] }, { landed: [], conflicts: [{ id: 3 }] }, { landed: [], reopened: 1 }]) {
    assert.equal(landingRetryAt({ ...moved, deferredUntil, waiting: true }, NOW), next, JSON.stringify(moved));
  }
  assert.equal(landingRetryAt({ landed: [], culprits: [], conflicts: [], reopened: 0, deferredUntil, waiting: true }, NOW), deferredUntil);
  assert.equal(landingRetryAt({ landed: [], deferredUntil, waiting: false }, NOW), null, 'a deferral has no wake when nothing waits');
});

test('clause 2: a deferral schedules no wake when nothing waits, whether the run moved work or not [C7]', () => {
  const deferredUntil = '2026-11-04T07:03:00.000Z';
  for (const moved of [{ landed: [], culprits: [], conflicts: [], reopened: 0 }, { landed: [1] },
    { landed: [], culprits: [{ id: 2 }] }, { landed: [], conflicts: [{ id: 3 }] }, { landed: [], reopened: 1 }]) {
    assert.equal(landingRetryAt({ ...moved, deferredUntil, waiting: false }, NOW), null, JSON.stringify(moved));
  }
});
