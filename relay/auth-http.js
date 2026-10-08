/** Embeddable web/device sign-in routes for the opt-in relay [H8, H1]. */
import { Refused } from '../src/refused.js';

/** Read one named cookie; duplicate bindings are refused instead of choosing an ambiguous value. */
function cookie(req, name) {
  const matches = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (matches.length > 1) throw new Refused('AUTH_REQUIRED', 'clear duplicate relay cookies and sign in again');
  return matches[0]?.slice(name.length + 1);
}

/** Parse a bounded JSON object, never surfacing request contents in refusals. */
async function body(req) {
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new Refused('BAD_REQUEST', 'send an application/json object');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Refused('BAD_REQUEST', 'send a JSON object smaller than 16 KiB');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refused('BAD_REQUEST', 'send a valid JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused('BAD_REQUEST', 'send a JSON object');
  return value;
}

/** Emit a versioned response with credentials protected from caches. */
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ version: 1, ...data }));
}

/** Use a configured public origin, never a client-controlled Host or proxy header. */
export function createAuthHandler({ auth, publicOrigin }) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Refused('RELAY_CONFIG', 'configure the relay public origin'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) throw new Refused('RELAY_CONFIG', 'use an HTTPS public origin, or a loopback HTTP origin for local tests');
  const secure = origin.protocol === 'https:' ? '; Secure' : '';
  const routes = new Set(['GET /auth/github/start', 'GET /auth/github/callback', 'POST /auth/device/start', 'POST /auth/device/poll', 'GET /auth/session', 'GET /auth/boards', 'POST /auth/boards/link', 'GET /auth/tokens', 'POST /auth/tokens', 'POST /auth/tokens/revoke']);

  /** Resolve a bearer or cookie credential; cookie writes require an exact trusted Origin. */
  function token(req, write = false) {
    const authorization = req.headers.authorization;
    if (authorization) {
      const match = /^Bearer ((?:ps_|pa_)[A-Za-z0-9_-]{43})$/.exec(authorization);
      if (!match) throw new Refused('AUTH_REQUIRED', 'send a current relay bearer credential');
      return match[1];
    }
    const session = cookie(req, 'pb_session');
    if (write && req.headers.origin !== origin.origin) throw new Refused('BAD_ORIGIN', 'send cookie-authorized writes from the relay origin');
    return session;
  }

  /** Handle only auth routes and return false so the relay's API handler can serve other paths. */
  return async function handleAuth(req, res) {
    const url = new URL(req.url, origin);
    const route = req.method + ' ' + url.pathname;
    if (!routes.has(route)) return false;
    try {
      if (route === 'GET /auth/github/start') {
        const flow = auth.beginWeb();
        res.writeHead(302, { location: flow.authorizationURL, 'Cache-Control': 'no-store', 'Set-Cookie': 'pb_oauth_binding=' + flow.binding + '; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=600' + secure });
        res.end();
      } else if (route === 'GET /auth/github/callback') {
        if (url.searchParams.has('error')) throw new Refused('OAUTH_DENIED', 'GitHub sign-in was declined; start again to sign in');
        const signed = await auth.finishWeb(url.searchParams.get('state'), url.searchParams.get('code'), cookie(req, 'pb_oauth_binding'));
        res.writeHead(303, { location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': ['pb_session=' + signed.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.max(0, Math.floor((signed.expires - Date.now()) / 1000)) + secure, 'pb_oauth_binding=; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=0' + secure] });
        res.end();
      } else if (route === 'POST /auth/device/start') {
        await body(req);
        json(res, 200, await auth.beginDevice());
      } else if (route === 'POST /auth/device/poll') {
        const input = await body(req);
        json(res, 200, await auth.pollDevice(input.ticket));
      } else if (route === 'GET /auth/session') {
        json(res, 200, { session: await auth.authenticate(token(req), { ...(url.searchParams.has('board') ? { board: url.searchParams.get('board') } : {}) }) });
      } else if (route === 'GET /auth/boards') {
        json(res, 200, { boards: await auth.boardsFor(token(req)) });
      } else if (route === 'POST /auth/boards/link') {
        const bearer = token(req, true);
        const input = await body(req);
        json(res, 200, { board: await auth.linkBoard(bearer, input.board, input.repository) });
      } else if (route === 'GET /auth/tokens') {
        json(res, 200, { tokens: await auth.listTokens(token(req), url.searchParams.get('board')) });
      } else if (route === 'POST /auth/tokens') {
        const bearer = token(req, true);
        const input = await body(req);
        json(res, 201, await auth.issueToken(bearer, input));
      } else {
        const bearer = token(req, true);
        const input = await body(req);
        json(res, 200, await auth.revoke(bearer, input.id));
      }
    } catch (error) {
      const code = error instanceof Refused ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof Refused ? error.message.replace(/^\[[^\]]+\] /, '') : 'the relay could not complete this request; retry or contact its coordinator';
      const status = code === 'BOARD_NOT_LINKED' ? 404 : code === 'AUTH_REQUIRED' ? 401 : ['NO_REPO_ACCESS', 'TOKEN_BOARD', 'TOKEN_NOT_OWNED', 'HUMAN_REQUIRED', 'BAD_ORIGIN', 'WRITE_REQUIRED'].includes(code) ? 403 : code === 'GITHUB_UNAVAILABLE' ? 503 : code === 'INTERNAL_ERROR' ? 500 : 400;
      json(res, status, { error: { code, message, next: message } });
    }
    return true;
  };
}
