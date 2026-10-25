/** HTTP boundary for board-key requests between a member's devices [E17,H15]. */
import {
  apiJson,
  apiRefusal,
  apiStatus,
  readApiBody,
} from '../src/api-http.js';
import { Refused } from '../src/refused.js';

const ROUTE = /^\/api\/v1\/boards\/([0-9a-f]{32})\/key-requests(?:\/([A-Za-z0-9_-]{22}))?$/u;

/**
 * Route key requests after the relay's normal board authorization. Only a person's sign-in asks for a key, and
 * only a person's own machine answers, so an agent token can neither request nor hand over a board key.
 */
export function createKeyRequestHandler({ authenticate, requests }) {
  return async function handleKeyRequest(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return false; }
    const match = ROUTE.exec(url.pathname);
    if (!match) return false;
    try {
      const [, board, id] = match;
      if (!id && req.method === 'POST') {
        const who = await authenticate(req, board, true);
        if (who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'ask for a board key from your own sign-in: run pullboard relay on in the clone');
        apiJson(res, 201, requests.publish(board, await readApiBody(req, { maxBytes: 16_384 }), who));
      } else if (!id && req.method === 'GET') {
        const who = await authenticate(req, board, false);
        if (!['machine', 'session'].includes(who.kind)) throw new Refused('HUMAN_REQUIRED', 'only a member’s linked computer hands over a board key');
        apiJson(res, 200, { requests: requests.waiting(board) });
      } else if (id && req.method === 'PUT') {
        const who = await authenticate(req, board, true);
        if (!['machine', 'session'].includes(who.kind)) throw new Refused('HUMAN_REQUIRED', 'only a member’s linked computer hands over a board key');
        apiJson(res, 200, requests.answer(board, id, await readApiBody(req, { maxBytes: 16_384 })));
      } else if (id && req.method === 'GET') {
        apiJson(res, 200, requests.read(board, id, await authenticate(req, board, false)));
      } else throw new Refused('NO_ENDPOINT', 'use POST or GET on key-requests, and PUT or GET on one request');
    } catch (error) {
      apiJson(res, apiStatus(error), apiRefusal(error));
    }
    return true;
  };
}
