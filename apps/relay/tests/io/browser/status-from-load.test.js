/** statusFromLoad builds the relay status a refused read needs from an exclusion load [C7,#9765]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusFromLoad } from '../../../src/io/browser/status.js';

const EXCLUSIONS = [{ machine: 'machine-a', label: 'Machine A', count: 1, names: ['corey/quant'], by: 'corey', reason: 'private' }];

test('clause 1: statusFromLoad names the excluded entry for the open board and null for another board [C7,#9765]', () => {
  const open = statusFromLoad({ openBoard: 'corey/quant', exclusions: EXCLUSIONS, machines: [] });
  assert.equal(open.excluded.name, 'corey/quant');
  assert.equal(open.excluded.by, 'corey');
  assert.equal(open.excluded.machine, 'machine-a');
  assert.equal(statusFromLoad({ openBoard: 'corey/other', exclusions: EXCLUSIONS, machines: [] }).excluded, null);
});

test('clause 2: statusFromLoad returns relayOn true with the machine list it was given [C7,#9765]', () => {
  const machines = [{ id: 'machine-a', label: 'Machine A', online: true }];
  const status = statusFromLoad({ openBoard: 'corey/quant', exclusions: [], machines });
  assert.equal(status.relayOn, true);
  assert.equal(status.machine, null);
  assert.deepEqual(status.machines, machines);
  assert.deepEqual(statusFromLoad({ openBoard: 'x', exclusions: [] }).machines, []);
});

test('clause 3: statusFromLoad of an empty exclusion list has excluded null [C7,#9765]', () => {
  assert.equal(statusFromLoad({ openBoard: 'corey/quant', exclusions: [], machines: [] }).excluded, null);
  assert.equal(statusFromLoad({ openBoard: 'corey/quant', exclusions: null }).excluded, null);
});
