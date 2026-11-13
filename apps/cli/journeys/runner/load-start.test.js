/** A fixture board starts a local test at once; a real seat waits for load [C7] (#7257). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localLoadStart } from '../../../../packages/gate/src/io/test/run.js';

test('a fixture board starts at once while a real seat still waits under load [C7]', async () => {
  const fixture = await localLoadStart({ env: { PULLBOARD_FIXTURE_BOARD: '1' }, read: () => [15], cores: 10, wait: async () => assert.fail('a fixture board never waits for load') });
  assert.equal(fixture.load, 15);
  const loads = [[15], [12], [4]];
  const waits = [];
  const real = await localLoadStart({ env: {}, read: () => loads.shift(), cores: 10, wait: async ms => { waits.push(ms); }, pollMs: 5 });
  assert.deepEqual(waits, [5, 5], 'a plain env waits exactly as before');
  assert.equal(real.load, 4);
});
