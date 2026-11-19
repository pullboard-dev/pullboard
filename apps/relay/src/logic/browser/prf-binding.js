/** Check that a PRF unlock ceremony is bound to its person and place: verified presence, same account, RP, origin and challenge [E22,H16]. */

/** The keys a ceremony must match its expectation on, in the order they are checked. */
const BOUND = ['account', 'rpId', 'origin', 'challenge'];

/** A refusal by name, with the next step; shaped as the kernel's Refused (name, code, next) so a caller can rethrow it as one [E22,H16]. */
function refusal(code, message, next) {
  return Object.assign(new Error(`[${code}] ${message}`), { name: 'Refused', code, next });
}

/**
 * Pass when the ceremony's presence is verified and its account, rpId, origin and challenge each equal the expected one;
 * refuse PRF_PRESENCE for unverified presence and PRF_BINDING naming the first key that differs. Why: a PRF output
 * unlocks only for the same account, relying party, origin and challenge the person confirmed; there is no fallback
 * result that unlocks anyway [E22,H16].
 * @param {{ presence?: boolean, account?: string, rpId?: string, origin?: string, challenge?: string }} ceremony
 * @param {{ account?: string, rpId?: string, origin?: string, challenge?: string }} expected
 * @returns {true}
 */
export function requirePrfBinding(ceremony, expected) {
  if (ceremony?.presence !== true) {
    throw refusal('PRF_PRESENCE', 'the passkey did not verify the person present', 'confirm with the passkey again, with user verification');
  }
  for (const key of BOUND) {
    if (typeof expected?.[key] !== 'string' || !expected[key] || ceremony[key] !== expected[key]) {
      throw refusal('PRF_BINDING', `the ceremony's ${key} is not the expected ${key}`, 'start a new unlock for this account, relying party, origin and challenge');
    }
  }
  return true;
}
