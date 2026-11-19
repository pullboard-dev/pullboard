/** statusFromLoad builds the relay status a refused read needs from an exclusion load [C7,#9765]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusFromLoad } from '../../../src/io/browser/status.js';

const EXCLUSIONS = [{ machine: 'machine-a', label: 'Machine A', count: 1, names: ['owner/project'], by: 'alice', reason: 'private' }];

test('relay.io-browser-status-from-load.statusfromload-names-the-excluded-entry-for: clause 1: statusFromLoad names the excluded entry for the open board and null for another board [C7,#9765]', () => {
  const open = statusFromLoad({ openBoard: 'owner/project', exclusions: EXCLUSIONS, machines: [] });
  assert.equal(open.excluded.name, 'owner/project');
  assert.equal(open.excluded.by, 'alice');
  assert.equal(open.excluded.machine, 'machine-a');
  assert.equal(statusFromLoad({ openBoard: 'owner/other', exclusions: EXCLUSIONS, machines: [] }).excluded, null);
});

test('relay.io-browser-status-from-load.statusfromload-returns-relayon-true-with-the: clause 2: statusFromLoad returns relayOn true with the machine list it was given [C7,#9765]', () => {
  const machines = [{ id: 'machine-a', label: 'Machine A', online: true }];
  const status = statusFromLoad({ openBoard: 'owner/project', exclusions: [], machines });
  assert.equal(status.relayOn, true);
  assert.equal(status.machine, null);
  assert.deepEqual(status.machines, machines);
  assert.deepEqual(statusFromLoad({ openBoard: 'x', exclusions: [] }).machines, []);
});

test('relay.io-browser-status-from-load.statusfromload-of-an-empty-exclusion-list: clause 3: statusFromLoad of an empty exclusion list has excluded null [C7,#9765]', () => {
  assert.equal(statusFromLoad({ openBoard: 'owner/project', exclusions: [], machines: [] }).excluded, null);
  assert.equal(statusFromLoad({ openBoard: 'owner/project', exclusions: null }).excluded, null);
});
