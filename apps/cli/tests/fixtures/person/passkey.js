/** A software passkey that answers WebAuthn exactly as a phone or browser authenticator does [E22,H16]. */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import {
  proposePersonMove,
  setPersonSigning,
} from '../../../../../packages/person/index.js';
import { validatePersonRequest } from '../../../../../packages/person/light.js';
import { receivePersonRequest } from '../../../../../packages/link/index.js';

/** SHA-256 bytes of a value. */
function sha256(value) { return createHash('sha256').update(value).digest(); }

/** Encode one CBOR head: a major type and its unsigned argument. */
function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const bytes = Buffer.alloc(3); bytes[0] = (major << 5) | 25; bytes.writeUInt16BE(value, 1); return bytes;
}

/** Encode the small CBOR subset a COSE public key uses: integers, byte strings and one map. */
function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  const entries = [...value.entries()];
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

/**
 * Make one ES256 passkey for an origin. `create` answers registration and `get` answers an assertion; each returns
 * the base64url fields a browser's PublicKeyCredential exposes. `presence: false` models an authenticator answering
 * with no user present, which is what software acting on the person's behalf could produce at best.
 */
export function softwarePasskey(origin) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = randomBytes(16);
  const id = raw.toString('base64url');
  const rpId = new URL(origin).hostname;
  let counter = 0;
  /** Authenticator data: the RP id hash, flags, a rising signature counter and any attested credential. */
  function authenticatorData(flags, attested = Buffer.alloc(0)) {
    const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, attested]);
  }
  /** The client data a browser builds for a ceremony. */
  function clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  return {
    id,
    /** Register: attested credential data carries the COSE key, with user presence set. */
    create(challenge) {
      const jwk = publicKey.export({ format: 'jwk' });
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const length = Buffer.alloc(2); length.writeUInt16BE(raw.length);
      const data = authenticatorData(0x41, Buffer.concat([Buffer.alloc(16), length, raw, cose]));
      return { id, clientDataJSON: clientData('webauthn.create', challenge).toString('base64url'), authenticatorData: data.toString('base64url') };
    },
    /** Assert over a challenge; user presence is set unless this models an absent person. */
    get(challenge, { presence = true, origin: claimed } = {}) {
      const data = authenticatorData(presence ? 0x05 : 0x00);
      const client = claimed ? Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: claimed })) : clientData('webauthn.get', challenge);
      const signature = sign('sha256', Buffer.concat([data, sha256(client)]), privateKey);
      return { credential: id, clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'), signature: signature.toString('base64url') };
    },
  };
}

/** The WebAuthn challenge for a person grant: SHA-256 of the grant, so the grant itself never reaches an authenticator. */
export function grantChallenge(grant) {
  return sha256(grant).toString('base64url');
}

/**
 * Record each signed-person-move event on a board the way the engine does: signing on, a terminal's proposal, and
 * the person's passkey-stamped request turning it off. The stamp's signature is a placeholder: replay reads stamps
 * as the relay attested them, and only a board with a pinned relay key checks the signature.
 *
 * @param {any} board
 * @param {string} agentId - the agent turning signing on and proposing
 */
export function recordSigningEvents(board, agentId) {
  setPersonSigning(board, { agentId, signed: true });
  const document = validatePersonRequest({ version: 1, type: 'person-request', id: 'signing-off-example', move: { verb: 'signing', args: { signed: 'off' } } });
  proposePersonMove(board, { agentId, request: document });
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const cursor = Number(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get()?.meta_value ?? 0);
  const presence = { board: boardId, request: document.id, digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    credential: 'fixture-passkey', at: 1, signature: 'A'.repeat(86) };
  receivePersonRequest(board, document, { sequence: cursor + 1, at: new Date().toISOString(), sender: { kind: 'person', userId: 'fixture-person', presence } });
  setPersonSigning(board, { agentId: 'person', signed: false, request: document.id });
}
