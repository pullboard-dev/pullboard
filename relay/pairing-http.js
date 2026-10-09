/** Authenticated, no-store HTTP boundary for one-use client-encrypted pairing envelopes [H15,H17]. */
import { apiJson, apiRefusal, apiStatus, readApiBody } from '../src/api-http.js';
import { Refused } from '../src/refused.js';

const PAIR_BODY = 20_000_000;
const ROUTE = /^\/api\/v1\/pairings\/([0-9a-f]{32})\/([A-Za-z0-9_-]{22})(\/consume)?$/;

/** Accept only the small exact body shape; do not let callers attach tokens or board metadata. */
function exactBody(value, fields) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Refused('BAD_REQUEST', 'send only the fields required by this pairing action');
  }
  return value;
}

/** Route publishes and consumes only after the adapter confirms the caller can read this board. */
export function createPairingHandler({ authenticate, pairings }) {
  if (typeof authenticate !== 'function' || !pairings || typeof pairings.publish !== 'function' || typeof pairings.consume !== 'function') {
    throw new Refused('PAIR_CONFIG', 'configure relay authentication and a bounded pairing store');
  }

  /** Handle only pairing paths so the normal relay API may serve every other request. */
  return async function handlePairing(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { return false; }
    const match = ROUTE.exec(url.pathname);
    if (!match) return false;
    try {
      const [, board, locator, consuming] = match;
      if (url.search) throw new Refused('BAD_REQUEST', 'send pairing fields in the request body, not the URL');
      if (req.method !== 'POST') throw new Refused('NO_ENDPOINT', 'use POST to publish or consume a one-time pairing package');
      await authenticate(req, { board, write: false });
      if (consuming) {
        exactBody(await readApiBody(req), []);
        apiJson(res, 200, pairings.consume(board, locator));
        return true;
      }
      const input = exactBody(await readApiBody(req, { maxBytes: PAIR_BODY }), ['sealed']);
      apiJson(res, 201, pairings.publish(board, locator, input.sealed));
      return true;
    } catch (error) {
      apiJson(res, apiStatus(error), apiRefusal(error));
      return true;
    }
  };
}
