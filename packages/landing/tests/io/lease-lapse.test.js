/** A landing lease that lapses is renewed once, then times out as LAND_GATE_TIMEOUT, never as a landing fault [C7]. @pullboard-test-input source-cell landing */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renewLapsedOnce } from '../../src/io/resource.js';
import { landingFault } from '../../src/io/step/diagnose.js';
import { itemRefusal } from '../../src/io/step/diagnose.js';
import { Refused } from '../../../kernel/index.js';

const lapse = () => new Refused('LAND_LEASE_LOST', 'lapsed');

test('clause 1: a lapsed lease is renewed once through renewWithBackoff and the land goes on if it renews [C7]', async () => {
  let calls = 0;
  const seen = [];
  const result = await renewLapsedOnce(() => { if (++calls === 1) throw lapse(); return 'renewed'; }, { onLapse: error => seen.push(error.code), pausing: async () => {} });
  assert.equal(result, 'renewed');
  assert.equal(calls, 2);
  assert.deepEqual(seen, ['LAND_LEASE_LOST']);
});

test('clause 1: a lease that lapses twice ends the land LAND_GATE_TIMEOUT after exactly two renewals [C7]', async () => {
  let calls = 0;
  await assert.rejects(renewLapsedOnce(() => { calls++; throw lapse(); }, { pausing: async () => {} }), { code: 'LAND_GATE_TIMEOUT' });
  assert.equal(calls, 2);
});

test('clause 1: a momentary BOARD_BUSY inside a renewal still backs off through renewWithBackoff [C7]', async () => {
  let calls = 0;
  const waits = [];
  const result = await renewLapsedOnce(() => { if (++calls < 3) throw new Refused('BOARD_BUSY', 'busy'); return 'ok'; }, { pausing: async ms => { waits.push(ms); }, until: () => Date.now() + 120_000 });
  assert.equal(result, 'ok');
  assert.deepEqual(waits, [100, 200]);
});

test('clause 2: the double lapse is no landing fault and no item refusal, so nothing is reported as infrastructure or blamed [C7]', async () => {
  const error = await renewLapsedOnce(() => { throw lapse(); }, { pausing: async () => {} }).catch(caught => caught);
  assert.equal(error.code, 'LAND_GATE_TIMEOUT');
  assert.equal(landingFault(error), false);
  assert.equal(itemRefusal(error), false);
});

test('clause 2: any other refusal passes through the lapse retry untouched [C7]', async () => {
  let calls = 0;
  await assert.rejects(renewLapsedOnce(() => { calls++; throw new Refused('LAND_WORKER', 'stopped'); }), { code: 'LAND_WORKER' });
  assert.equal(calls, 1);
});
