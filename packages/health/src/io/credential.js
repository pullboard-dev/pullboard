/** Health names a relay credential that is about to lapse, or has lapsed, with its one-step fix [C7,#9331]. */

/** How long before expiry the finding appears: three days. */
export const CREDENTIAL_WARN_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * At most one finding for this computer's relay machine credential: "expiring" within 3 days of its expiry, "expired" after it.
 * Only the expiry time is read from the link; the credential's value never enters a finding or its detail.
 * Why: a lapsed credential stops syncing without a word, so the person hears about it a few days early.
 *
 * @param {{ tokenExpires?: number|null }|null|undefined} link - The relay link's public fields.
 * @param {number} now - Observation time in milliseconds.
 * @param {(cause: string, item: any, fields: object) => object} finding - The health finding builder.
 * @returns {object[]}
 */
export function credentialExpiryFindings(link, now, finding) {
  const expires = link?.tokenExpires;
  if (!Number.isSafeInteger(expires) || expires <= 0 || expires - now > CREDENTIAL_WARN_MS) return [];
  const expired = expires <= now;
  const at = new Date(expired ? expires : expires - CREDENTIAL_WARN_MS).toISOString();
  const when = new Date(expires).toISOString();
  return [finding(expired ? 'RELAY_CREDENTIAL_EXPIRED' : 'RELAY_CREDENTIAL_EXPIRING', null, {
    subject: 'relay credential', key: `RELAY_CREDENTIAL:${expired ? 'expired' : 'expiring'}`, since: at, now,
    title: expired ? 'the relay credential has expired' : 'the relay credential expires within 3 days',
    why: expired ? `This computer's relay credential expired at ${when}; syncs are refused until it is renewed`
      : `This computer's relay credential expires at ${when}; a good sync renews it, and none has`,
    next: 'pullboard relay on', command: 'pullboard relay on',
    owner: { role: 'coordinator', who: 'coordinator' }, detail: { expiresAt: when, expired },
  })];
}
