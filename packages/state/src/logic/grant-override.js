/** Validate a signed grant override record; it checks and grants nothing yet [C7,#1184]. */
/** A refusal by name, with the next step; shaped as the kernel's Refused (name, code, next) so a caller can rethrow it as one [C7,#1184]. */
function refusal(code, message, next) {
  return Object.assign(new Error(`[${code}] ${message}`), { name: 'Refused', code, next });
}

/** The time of a date, a millisecond count, or an ISO string, or NaN when it names none. */
function instant(value) {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value ?? ''));
}

/**
 * Accept an override record { agent, grant, reason, expiresAt, signature } that is signed, gives a reason and expires
 * after `now`; refuse it by name otherwise. Why: a person-granted override must be attributable and short-lived; the
 * caller checks the signature itself, so here signed means a non-empty signature field [C7,#1184].
 * @param {{ agent?: string, grant?: string, reason?: string, expiresAt?: string | number | Date, signature?: string }} record
 * @param {number | Date} now
 * @returns {object} The record, when accepted.
 */
export function checkGrantOverride(record, now) {
  if (typeof record?.signature !== 'string' || !record.signature.trim()) {
    throw refusal('GRANT_UNSIGNED', 'the grant override carries no signature', 'have the person sign the override, then present it again');
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    throw refusal('GRANT_NO_REASON', 'the grant override gives no reason', 'add the reason the person signed it for');
  }
  if (!(instant(record.expiresAt) > instant(now))) {
    throw refusal('GRANT_EXPIRED', 'the grant override has expired', 'ask the person for a new override with a future expiry');
  }
  return record;
}
