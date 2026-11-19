/** Rolling relay credential renewal after a good sync; no bearer value is printed or returned [H5,H16,#9330]. */
import { Refused } from '../../../../kernel/light.js';
import {
  request,
  saveLink,
} from '../relay.js';
import { renewOn } from './config.js';

/** Keep only the issuance dates a later expiry warning needs. */
export function rememberMachine(state, issued) {
  state.tokenExpires = Number.isSafeInteger(issued.expires) && issued.expires > 0 ? issued.expires : null;
  state.tokenCreated = Number.isSafeInteger(issued.created) && issued.created > 0 ? issued.created : null;
}

/**
 * After a successful sync, ask the relay to renew this computer's own machine credential once and keep the new expiry on the link.
 * Why: a computer that syncs should not lapse; but a renewal is housekeeping, so nothing here ever fails the sync it follows, and its
 * notice never says uploads are pending. Off unless relay.renewAfterSync is on (or `io.renewAfterSync` says so).
 *
 * @param {string} file - The saved link file.
 * @param {any} state - The loaded link.
 * @param {any} io - The relay io; `err` takes the one-line notice.
 * @returns {Promise<void>}
 */
export async function renewAfterSync(file, state, io) {
  if (!(io.renewAfterSync ?? renewOn()) || !state.token?.startsWith('pm_')) return;
  try {
    const reply = await request(state, '/auth/credentials/renew', { method: 'POST', body: { board: state.board } }, io);
    if (reply.board !== state.board || reply.id !== state.tokenId || reply.kind !== 'machine' || reply.machine !== state.machine
      || !Number.isSafeInteger(reply.renewedAt) || !Number.isSafeInteger(reply.expires) || reply.expires <= reply.renewedAt) {
      throw new Refused('RELAY_RESPONSE', 'the relay returned invalid credential renewal metadata');
    }
    rememberMachine(state, reply);
    saveLink(file, state);
  } catch (error) {
    // An older relay has no renewal route; keep its original expiry quietly.
    if (error.httpStatus === 404) return;
    io.err(`pullboard: the sync worked, but the relay credential did not renew (${error.code ?? 'ERROR'}); run pullboard relay on to sign in again`);
  }
}
