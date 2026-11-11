/** Deliver root-authenticated enrollments without adding unrestricted legacy roster authority [H15]. */
import { authenticatePersonEnrollment } from '../../../../person/light.js';
import { readBoardKey } from '../relay.js';
import { wrapDeviceBoardKey } from '../../logic/device.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Verify the current board and caller-owned pin, reading it again before releasing any wrapped key. */
export async function deliverPersonEnrollments(state, io, send, { relayPersonRoot }) {
  const pin = relayPersonRoot(state);
  if (!pin) return;
  const path = '/api/v1/devices/person-enrollments';
  const pending = await send(state, path, { method: 'GET' }, io);
  if (!Array.isArray(pending.enrollments) || pending.enrollments.length > 50) {
    throw new Refused('RELAY_RESPONSE', 'Use the bounded account enrollment queue.');
  }
  for (const value of pending.enrollments) {
    try {
      // The signature authenticates its full grant manifest; this machine independently clamps it to its own board.
      const body = await authenticatePersonEnrollment(pin.publicKey, value, { account: state.account,
        origin: pin.origin, nonce: value?.nonce, grants: value?.grants, now: Date.now() });
      if (!body.grants.includes(state.board)) throw new Refused('PERSON_ENROLL_AUTH', 'Wrap only this machine credential’s board.');
      const status = await send(state, '/api/v1/devices/' + body.device, { method: 'GET' }, io);
      if (status.revoked === true) throw new Refused('PERSON_ENROLL_REVOKED', 'Use a non-revoked browser enrollment.');
      if (status.revoked !== false && status.revoked !== null) throw new Refused('RELAY_RESPONSE', 'Read the device’s current revocation state.');
      const wrapped = await wrapDeviceBoardKey(readBoardKey(state.board), body.publicKey,
        { board: state.board, device: body.device, engine: ENGINE_VERSION });
      if (JSON.stringify(relayPersonRoot(state)) !== JSON.stringify(pin)) {
        throw new Refused('PERSON_ENROLL_AUTH', 'The local person root changed; authenticate a fresh enrollment.');
      }
      await send(state, path + '/' + body.nonce, { method: 'PUT', body: { board: state.board,
        engine: ENGINE_VERSION, wrapped: Buffer.from(JSON.stringify(wrapped)).toString('base64url') } }, io);
    } catch (error) {
      // Untrusted public challenges must not block other valid enrollments or ordinary board synchronization.
      if (!['PERSON_ENROLL_AUTH', 'PERSON_ENROLL_EXPIRED', 'PERSON_ENROLL_REVOKED'].includes(error.code)) throw error;
      io.err?.(`pullboard: [${error.code}] ignored an invalid or revoked person enrollment; authenticate a fresh challenge`);
    }
  }
}
