/** Health names a relay credential within 3 days of expiry, with one next command and no bearer value [C7,#9331]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialExpiryFindings } from '../../index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const BEARER = ['pm', 'BEARER', 'VALUE'].join('_');
const finding = (cause, item, fields) => ({ cause, item, ...fields });
const run = (expiresIn) => credentialExpiryFindings({ token: BEARER, tokenId: 'cred1', tokenExpires: NOW + expiresIn }, NOW, finding);

test('health.credential.expiring-and-expired: clause 1: a credential 2 days from expiry yields an expiring finding, an expired one an expired finding, each with one next command and no bearer value [C7,#9331]', () => {
  const [soon] = run(2 * DAY);
  assert.equal(soon.cause, 'RELAY_CREDENTIAL_EXPIRING');
  const [gone] = run(-DAY);
  assert.equal(gone.cause, 'RELAY_CREDENTIAL_EXPIRED');
  for (const one of [soon, gone]) {
    assert.equal(one.next, 'pullboard relay on');
    assert.ok(!JSON.stringify(one).includes(BEARER), 'no bearer value anywhere in the finding');
    assert.ok(!JSON.stringify(one).includes('cred1'));
  }
});

test('health.credential.far-or-absent: clause 2: a credential 4 days from expiry yields no finding, nor does a link without an expiry [C7,#9331]', () => {
  assert.deepEqual(run(4 * DAY), []);
  assert.deepEqual(credentialExpiryFindings(null, NOW, finding), []);
  assert.deepEqual(credentialExpiryFindings({ tokenExpires: null }, NOW, finding), []);
});
