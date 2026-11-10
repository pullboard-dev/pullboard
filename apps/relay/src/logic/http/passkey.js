/** Passkey registration, person grants and the public stamp key over HTTP [E22,H16]. */
import {
  apiJson,
  apiRefusal,
  apiStatus,
  readApiBody,
} from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../../cli/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/**
 * Route the fixed passkey endpoints. Every one but the public key needs the person's own session: a machine or agent
 * credential is refused before any passkey work.
 *
 * @param {{ auth: any, origin: () => { origin: string, rpId: string }, person: (req: any, write: boolean) => Promise<any>, board: (req: any, id: string) => Promise<any> }} options
 */
export function createPasskeyHandler({ auth, origin, person, board }) {
  return async function handlePasskeys(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const grants = /^\/api\/v1\/boards\/([^/]+)\/person-grants$/u.exec(url.pathname);
    if (url.pathname !== '/.well-known/pullboard-person-authority' && !url.pathname.startsWith('/api/v1/passkeys') && !grants) return false;
    try {
      if (url.search) throw new Refused('BAD_REQUEST', 'keep passkey fields out of URL queries');
      if (url.pathname === '/.well-known/pullboard-person-authority' && req.method === 'GET') {
        apiJson(res, 200, { authority: auth.personAuthority() }); return true;
      }
      if (grants && req.method === 'POST') {
        const who = await board(req, grants[1]);
        apiJson(res, 200, auth.issuePersonGrant(who, grants[1], await readApiBody(req))); return true;
      }
      if (url.pathname === '/api/v1/passkeys/challenge' && req.method === 'POST') {
        const who = await person(req, true);
        await readApiBody(req);
        apiJson(res, 200, { ...auth.passkeyChallenge(who), rpId: origin().rpId }); return true;
      }
      if (url.pathname === '/api/v1/passkeys' && req.method === 'POST') {
        const who = await person(req, true);
        apiJson(res, 200, { passkey: auth.registerPasskey(who, await readApiBody(req), origin()) }); return true;
      }
      if (url.pathname === '/api/v1/passkeys' && req.method === 'GET') {
        apiJson(res, 200, { passkeys: auth.passkeys(await person(req, false)) }); return true;
      }
      throw new Refused('NO_ENDPOINT', 'use the documented passkey endpoints');
    } catch (error) { apiJson(res, apiStatus(error), apiRefusal(error, refusalDocument)); return true; }
  };
}
