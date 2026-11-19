/** A signed grant override record is checked for signature, reason and expiry [C7,#1184]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGrantOverride } from '../../src/logic/grant-override.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const signed = { agent: 'core-1', grant: 'claim', reason: 'unblock the lander', expiresAt: '2026-11-19T12:00:00Z', signature: 'sig-abc' };

test('state.logic-grant-override.accepts-signed-record: clause 1: checkGrantOverride(record, now) accepts a signed record with a reason and a future expiry [C7,#1184]', () => {
  assert.equal(checkGrantOverride(signed, NOW), signed);
});

test('state.logic-grant-override.refuses-unsigned-and-expired: clause 2: checkGrantOverride refuses an unsigned record with GRANT_UNSIGNED and an expired record with GRANT_EXPIRED, each by name [C7,#1184]', () => {
  assert.throws(() => checkGrantOverride({ ...signed, signature: '' }, NOW), { code: 'GRANT_UNSIGNED' });
  assert.throws(() => checkGrantOverride({ ...signed, signature: undefined }, NOW), { code: 'GRANT_UNSIGNED' });
  assert.throws(() => checkGrantOverride({ ...signed, expiresAt: '2026-11-18T11:59:59Z' }, NOW), { code: 'GRANT_EXPIRED' });
  assert.throws(() => checkGrantOverride({ ...signed, expiresAt: NOW }, NOW), { code: 'GRANT_EXPIRED' });
});
