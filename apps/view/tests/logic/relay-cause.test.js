/** The phone names the real relay cause and its one fix command, and keeps a network failure a connection problem [H5,N26]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayCauseMessage } from '../../src/logic/relay-cause.js';

test('clause 1: relay off and board excluded each map to their own message plus one fix command [H5]', () => {
  const off = relayCauseMessage({ cause: 'relay_off', machine: 'Studio' });
  assert.match(off.message, /off on Studio/u);
  assert.equal(off.command, 'pullboard relay on');
  const excluded = relayCauseMessage({ cause: 'excluded', machine: 'Studio', by: 'Corey', reason: 'private work' });
  assert.match(excluded.message, /excluded/u);
  assert.match(excluded.message, /Corey/u);
  assert.match(excluded.message, /private work/u);
  assert.equal(excluded.command, 'pullboard relay on');
  const unknown = relayCauseMessage({ cause: 'excluded', machine: 'Studio', by: null, reason: 'unknown historical exclusion' });
  assert.doesNotMatch(unknown.message, /unknown|by /u);
  assert.notEqual(off.message, excluded.message);
});

test('clause 1: a network failure maps to check your connection with no command [H5]', () => {
  const down = relayCauseMessage({ cause: 'connection', machine: 'Studio' });
  assert.match(down.message, /check your connection/iu);
  assert.equal(down.command, null);
  assert.deepEqual(relayCauseMessage(), relayCauseMessage({ cause: 'unknown' }));
});
