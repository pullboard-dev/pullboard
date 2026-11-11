/** The fixture relay's own passkey stamp key, so a test signs stamps the way the relay does [E22,H16]. */
import { createPrivateKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read the fixture relay's published authority and the private half it signs passkey stamps with. Why the relay's
 * own key: a board trusts only the authority its relay vouches for (#408), so a stamp made with any other key fails.
 *
 * @param {{ auth: { personAuthority: () => any }, authDatabase: string }} box - a relay client fixture
 * @returns {{ authority: { version: 1, algorithm: 'Ed25519', publicKey: string }, privateKey: import('node:crypto').KeyObject }}
 */
export function relayStampKey(box) {
  const authority = box.auth.personAuthority();
  const db = new DatabaseSync(box.authDatabase, { readOnly: true });
  try {
    const { private_key: key } = db.prepare('SELECT private_key FROM relay_person_authority WHERE slot=1').get();
    return { authority, privateKey: createPrivateKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'pkcs8' }) };
  } finally { db.close(); }
}
