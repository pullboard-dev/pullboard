/** A census prints, per host, the minutes its slots sat idle while jobs were still queued [C7,#10526]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { censusIdleLine } from '../../../src/logic/census.js';
import { censusIdleSlots } from '../../../src/logic/census.js';

const START = Date.parse('2026-11-17T10:00:00.000Z');
const at = minutes => new Date(START + minutes * 60_000).toISOString();
const job = (host, shard, from, to) => ({ file: `${shard}.test.js`, host, shard, status: 'green', claimedAt: at(from), endedAt: at(to) });

/** A recorded two-host census: host-a ran three jobs at once at its peak, host-b one, and the last first-pass claim came at minute 6. */
const ROWS = [
  job('host-a', '1/4', 0, 6), job('host-a', '1/4', 0, 6), job('host-a', '2/4', 0, 10), job('host-a', '3/4', 4, 14),
  job('host-b', '4/4', 6, 9), job('host-b', '4/4', 6, 9),
  { ...job('host-b', '4/4', 20, 22), outcomes: [] },
  { ...job('none', '5/4', 0, 1) },
];

test('cli.io-test-census-idle-slots.a-recorded-two-host-census-prints-idle: clause 1: a recorded two-host census prints, per host, the minutes its slots sat idle while jobs were still queued [C7,#10526]', () => {
  // The last first-pass claim is at minute 6, so the queued span is 6 minutes.
  const idle = censusIdleSlots(ROWS, START);
  // host-a ran 3 jobs at once at its peak: 18 slot-minutes of span, 6 + 6 + 2 busy inside it, so 4 idle.
  assert.equal(idle['host-a'], 4);
  // host-b has 1 slot and its one job starts at minute 6, after the span: all 6 slot-minutes idle.
  assert.equal(idle['host-b'], 6);
  assert.equal(idle.none, undefined, 'a row that ran on no host is not a host');
  assert.equal(censusIdleLine(idle), 'census idle slot-minutes while jobs were queued: host-a 4, host-b 6');
});

test('cli.io-test-census-idle-slots.a-census-with-no-host-prints-nothing: clause 1: a census whose rows ran on no host prints no idle line [C7,#10526]', () => {
  assert.deepEqual(censusIdleSlots([job('none', '1/1', 0, 1)], START), {});
  assert.equal(censusIdleLine({}), null);
});
