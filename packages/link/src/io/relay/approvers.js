/**
 * A board's approvers on the relay [E4,E20]. pullboard.json on accepted main names them; the relay keeps the same
 * GitHub logins as board metadata so it can stamp each person's records and refuse an unlink or snapshot from anyone
 * else. Only a person, signed in as themselves, sends the list, and the relay takes a change only from a current
 * approver, so a new list takes effect once an approver signs in with it.
 */
import { Refused } from '../../../../kernel/light.js';
import { request } from '../relay.js';
import { mainPolicy } from '../../../../sandbox/index.js';

/**
 * Send accepted main's approver list to the relay within a person's sign-in, when it differs from the relay's. A
 * refusal is reported and never stops the link: the old list stands until an approver brings the new one.
 *
 * @param {string} root - the board's checkout
 * @param {{ board: string, url: string }} state - the saved link
 * @param {string} session - the person's session token
 * @param {{ err?: (line: string) => void, say?: (line: string) => void }} io
 * @returns {Promise<string[] | null | undefined>} the relay's list after the call, or undefined when nothing was sent
 */
export async function syncApprovers(root, state, session, io) {
  let wanted;
  try { wanted = mainPolicy(root).config.approvers; } catch { return undefined; }
  const path = '/api/v1/boards/' + state.board + '/approvers';
  const current = (await request({ ...state, token: session }, path, {}, io)).approvers ?? null;
  const next = Array.isArray(wanted) && wanted.length ? [...wanted].sort() : null;
  if (JSON.stringify(current) === JSON.stringify(next)) return current;
  try {
    const saved = await request({ ...state, token: session }, path, { method: 'PUT', body: { approvers: next ?? [] } }, io);
    io.say?.(next ? `Approvers on the relay: ${next.join(', ')}.` : 'This board names no approvers on the relay.');
    return saved.approvers ?? null;
  } catch (error) {
    if (!(error instanceof Refused) || !['NOT_APPROVER', 'BAD_APPROVERS'].includes(error.code)) throw error;
    io.err?.(`pullboard: pullboard.json names different approvers, but ${error.message}`);
    return current;
  }
}
