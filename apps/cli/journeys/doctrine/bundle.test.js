/** A signed rule bundle verifies offline and refuses changed bytes, a wrong issuer and an expired waiver [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  encodeBundle,
  importBundle,
  ruleIdentity,
  signBundle,
  signWaiver,
  verifyBundle,
  waiverPermits,
} from '../../../../packages/doctrine/index.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ruleBoard = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const issuer = signBundle('x', ruleBoard.privateKey).key;
const RULES = [{ id: 'R1', text: 'Web pages stay TODO-free' }, { id: 'R2', text: 'Commits cite spec ids' }];

/** A bundle the given key signed, as a child board receives it. */
function received(key) {
  const { bytes, digest } = encodeBundle({ version: 1, originBoardId: 'rules', revision: 3, rules: RULES });
  return { bytes, digest, signatures: [signBundle(bytes, key)] };
}

const refusal = (run, code) => assert.throws(run, error => error.code === code && /\S+;/u.test(error.message) || error.code === code);

test('cli.journeys-doctrine-bundle.a-rule-bundle-verifies-offline-and: a rule bundle verifies offline and refuses changed bytes, a wrong issuer and an expired waiver [C7]', () => {
  // Offline: only bytes, signatures and the authorized key list; the valid bundle imports with origin and identity kept.
  const bundle = received(ruleBoard.privateKey);
  assert.equal(verifyBundle(bundle, [issuer]).issuer, issuer);
  const imported = importBundle(bundle, [issuer]);
  assert.deepEqual(Object.keys(imported.rules.rules), ['R1', 'R2']);
  assert.equal(ruleIdentity(imported.rules.rules.R1), 'rules/R1');

  // Changed bytes refuse, and nothing imports.
  const changed = { ...bundle, bytes: bundle.bytes.replace('TODO-free', 'TODO-rich') };
  refusal(() => verifyBundle(changed, [issuer]), 'BUNDLE_BYTES_CHANGED');
  refusal(() => importBundle(changed, [issuer]), 'BUNDLE_BYTES_CHANGED');

  // A valid signature from a key the rule board did not authorize refuses.
  refusal(() => verifyBundle(received(stranger.privateKey), [issuer]), 'BUNDLE_WRONG_ISSUER');
  refusal(() => verifyBundle({ ...bundle, signatures: [] }, [issuer]), 'BUNDLE_UNSIGNED');

  // A waiver permits its rule, revision and scope until the injected clock reaches its expiry, then refuses.
  const fields = { rule: 'R1', revision: 3, scope: 'child-a', reason: 'migration window', expires: '2026-11-17T12:00:00Z' };
  const waiver = signWaiver(fields, ruleBoard.privateKey);
  const wanted = { rule: 'R1', revision: 3, scope: 'child-a' };
  assert.equal(waiverPermits(waiver, wanted, { authorizedKeys: [issuer], now: () => NOW }), true);
  refusal(() => waiverPermits(waiver, wanted, { authorizedKeys: [issuer], now: () => Date.parse(fields.expires) }), 'BUNDLE_WAIVER_EXPIRED');
  refusal(() => waiverPermits(waiver, wanted, { authorizedKeys: [signBundle('x', stranger.privateKey).key], now: () => NOW }), 'BUNDLE_WAIVER_UNSIGNED');
});
