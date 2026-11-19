/** A PRF unlock needs verified presence and the same account, rpId, origin and challenge [E22,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requirePrfBinding } from '../../../src/logic/browser/prf-binding.js';

const expected = { account: 'acct-1', rpId: 'relay.example', origin: 'https://relay.example', challenge: 'chal-1' };
const ceremony = { presence: true, ...expected };

test('relay.logic-browser-prf-binding.passes-when-bound: clause 1: requirePrfBinding(ceremony, expected) passes when presence is verified and account, rpId, origin and challenge all match [E22,H16]', () => {
  assert.equal(requirePrfBinding(ceremony, expected), true);
});

test('relay.logic-browser-prf-binding.refuses-unbound: clause 2: requirePrfBinding refuses PRF_PRESENCE for unverified presence and PRF_BINDING for a mismatch in each of account, rpId, origin and challenge, with no fallback result [E22,H16]', () => {
  assert.throws(() => requirePrfBinding({ ...ceremony, presence: false }, expected), { code: 'PRF_PRESENCE' });
  assert.throws(() => requirePrfBinding({ ...ceremony, presence: undefined }, expected), { code: 'PRF_PRESENCE' });
  for (const key of ['account', 'rpId', 'origin', 'challenge']) {
    assert.throws(() => requirePrfBinding({ ...ceremony, [key]: 'other' }, expected), { code: 'PRF_BINDING' }, key);
    assert.throws(() => requirePrfBinding({ ...ceremony, [key]: undefined }, expected), { code: 'PRF_BINDING' }, key);
  }
});
