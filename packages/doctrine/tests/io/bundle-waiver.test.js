/** A scoped waiver binds issuer, rule, revision, scope, reason and expiry, and an unsigned or expired waiver grants nothing [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  signWaiver,
  waiverPermits,
} from '../../src/io/bundle/waiver.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const FIELDS = { rule: 'R', revision: 3, scope: 'S', reason: 'migration window', expires: '2026-11-17T12:00:00Z' };
const WANT = { rule: 'R', revision: 3, scope: 'S' };
const pair = () => generateKeyPairSync('ed25519');

/** A context whose clock is a fixed instant and whose authorized keys are the given waiver's issuer. */
const contextFor = (waiver, now = NOW) => ({ authorizedKeys: [waiver.issuer], now: () => now });

test('doctrine.io-bundle-waiver.clause-1-a-signed-waiver-for-rule-r: clause 1: a signed waiver for rule R revision 3 in scope S permits only that and a waiver for another rule, revision or scope permits nothing [C7]', () => {
  const waiver = signWaiver(FIELDS, pair().privateKey);
  const context = contextFor(waiver);
  assert.equal(waiverPermits(waiver, WANT, context), true);
  for (const other of [{ ...WANT, rule: 'R2' }, { ...WANT, revision: 4 }, { ...WANT, scope: 'T' }]) {
    assert.equal(waiverPermits(waiver, other, context), false);
  }
});

test('doctrine.io-bundle-waiver.clause-1-an-expired-waiver-refuses: clause 1: an expired waiver refuses BUNDLE_WAIVER_EXPIRED with a next step [C7]', () => {
  const waiver = signWaiver(FIELDS, pair().privateKey);
  assert.throws(() => waiverPermits(waiver, WANT, contextFor(waiver, Date.parse(FIELDS.expires))),
    error => error.code === 'BUNDLE_WAIVER_EXPIRED' && /new waiver/u.test(error.message));
});

test('doctrine.io-bundle-waiver.clause-1-an-unsigned-edited-or: clause 1: an unsigned, edited or unauthorized waiver refuses BUNDLE_WAIVER_UNSIGNED [C7]', () => {
  const waiver = signWaiver(FIELDS, pair().privateKey);
  const { signature: _signature, ...unsigned } = waiver;
  const widened = { ...waiver, scope: 'T' };
  const stranger = { authorizedKeys: [signWaiver(FIELDS, pair().privateKey).issuer], now: () => NOW };
  for (const [candidate, context] of [[unsigned, contextFor(waiver)], [widened, contextFor(waiver)], [waiver, stranger], [undefined, contextFor(waiver)]]) {
    assert.throws(() => waiverPermits(candidate, WANT, context), error => error.code === 'BUNDLE_WAIVER_UNSIGNED' && /again/u.test(error.message));
  }
});

test('doctrine.io-bundle-waiver.clause-2-expiry-is-read-from-the: clause 2: expiry is read from the injected clock, never the wall clock [C7]', () => {
  const waiver = signWaiver({ ...FIELDS, expires: '2001-01-01T00:00:00Z' }, pair().privateKey);
  assert.equal(waiverPermits(waiver, WANT, contextFor(waiver, Date.parse('2000-12-31T00:00:00Z'))), true);
  assert.throws(() => waiverPermits(waiver, WANT, contextFor(waiver, Date.parse('2001-01-02T00:00:00Z'))), error => error.code === 'BUNDLE_WAIVER_EXPIRED');
});
