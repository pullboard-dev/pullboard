/** A refused relay read carries the relay cause once a status is set, and never before [H5,H17,C7]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { test } from 'node:test';
import { attachRelayCause } from '../../../src/io/browser/status.js';
import { getRelayStatus } from '../../../src/io/browser/status.js';
import { setRelayStatus } from '../../../src/io/browser/status.js';

/** A failed read's refusal, shaped like the one the client throws. */
function refusal(code = 'RELAY_UNAVAILABLE') {
  return Object.assign(new Error(`[${code}] The relay did not answer. Sign in again or retry.`), { code });
}

afterEach(() => setRelayStatus(null));

test('clause 1: with a status of relay off set, a RELAY_UNAVAILABLE refusal carries relayCause relay_off [C7]', () => {
  setRelayStatus({ relayOn: false, machine: 'studio' });
  const error = attachRelayCause(refusal());
  assert.equal(error.relayCause.cause, 'relay_off');
  assert.equal(error.relayCause.machine, 'studio');
});

test('clause 2: with a status that excludes the board set, the refusal carries relayCause excluded [C7]', () => {
  setRelayStatus({ relayOn: true, machine: 'studio', excluded: { name: 'quant', by: 'corey', reason: 'private' } });
  const error = attachRelayCause(refusal());
  assert.equal(error.relayCause.cause, 'excluded');
  assert.equal(error.relayCause.by, 'corey');
});

test('clause 3: with no status set, the refusal carries no relayCause [C7]', () => {
  assert.equal(getRelayStatus(), null);
  assert.equal('relayCause' in attachRelayCause(refusal()), false);
  setRelayStatus({ relayOn: false });
  assert.equal('relayCause' in attachRelayCause(refusal('NO_BOARD')), false, 'only RELAY_UNAVAILABLE is given a cause');
});
