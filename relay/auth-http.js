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

/** Render a fixed confirmation shell; all board and host text comes from textContent after fetch. */
function deviceConfirmationPage() {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Confirm board link · Pullboard</title><main><h1>Confirm board link</h1><p id="status">Checking this sign-in…</p>' +
    '<p id="intent"></p><button id="confirm" hidden>Confirm link</button> <button id="decline" hidden>Decline</button></main>' +
    '<script>let ticket=decodeURIComponent(location.hash.slice(1));history.replaceState(null,"",location.pathname);const status=document.querySelector("#status");' +
    'const intent=document.querySelector("#intent");const confirmButton=document.querySelector("#confirm");const declineButton=document.querySelector("#decline");' +
    'let terminal=false;let pollTimer=null;/** Stop polling and make earlier status responses inert after a final decision. */function stopPolling(){terminal=true;if(pollTimer!==null){clearInterval(pollTimer);pollTimer=null;}}' +
    '/** Bind this browser tab to the one-use ticket without putting it in a request URL. */ async function openConfirmation(){' +
    'const response=await fetch("/auth/device/confirmation/open",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})});' +
    'const value=await response.json();if(!response.ok)throw new Error(value.error?.message||"This confirmation expired.");}' +
    '/** Read the current grant without exposing a session credential to the page. */ async function refresh(){if(terminal)return;try{' +
    'const response=await fetch("/auth/device/confirmation/status",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})});' +
    'if(terminal)return;const value=await response.json();if(terminal)return;if(!response.ok)throw new Error(value.error?.message||"This confirmation expired.");' +
    'if(value.declined){stopPolling();status.textContent="You declined this board link. Nothing was linked.";return;}' +
    'if(value.confirmed){stopPolling();status.textContent="The board is linked. You can return to the terminal.";return;}' +
    'if(!value.ready){status.textContent="Finish GitHub sign-in in the other tab, then this page will ask you to confirm.";return;}' +
    'status.textContent="Signed in as @"+value.account+". Confirm only if this is the board and machine you intended.";' +
    'intent.textContent="Link "+value.intent.boardName+" from "+value.intent.host+(value.intent.replaces?", replacing board "+value.intent.replaces:"")+"?";confirmButton.hidden=false;declineButton.hidden=false;' +
    '}catch(error){if(terminal)return;status.textContent=error.message;confirmButton.hidden=true;declineButton.hidden=true;}}' +
    '/** Send an exact-origin, cookie-bound confirmation decision. */ async function decide(decision){confirmButton.disabled=true;declineButton.disabled=true;try{' +
    'const response=await fetch("/auth/device/confirmation",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({ticket,decision})});const value=await response.json();if(!response.ok)throw new Error(value.error?.message||"The relay could not confirm this link.");stopPolling();' +
    'status.textContent=value.confirmed?"The board is linked. You can return to the terminal.":"You declined this board link. Nothing was linked.";' +
    'confirmButton.hidden=true;declineButton.hidden=true;}catch(error){status.textContent=error.message;confirmButton.disabled=false;declineButton.disabled=false;}}' +
    'confirmButton.onclick=()=>decide("confirm");declineButton.onclick=()=>decide("decline");' +
    'void openConfirmation().then(refresh).catch(error=>{if(!terminal)status.textContent=error.message;});pollTimer=setInterval(()=>{if(!terminal&&confirmButton.hidden)void refresh();},2000);</script></html>';
}

/** Use a configured public origin, never a client-controlled Host or proxy header. */
export function createAuthHandler({ auth, publicOrigin }) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Refused('RELAY_CONFIG', 'configure the relay public origin'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) throw new Refused('RELAY_CONFIG', 'use an HTTPS public origin, or a loopback HTTP origin for local tests');
  const secure = origin.protocol === 'https:' ? '; Secure' : '';
  const routes = new Set(['GET /auth/github/start', 'GET /auth/github/callback', 'POST /auth/device/start', 'POST /auth/device/poll', 'POST /auth/device/cancel',
    'GET /auth/device/confirm', 'POST /auth/device/confirmation/open', 'POST /auth/device/confirmation/status', 'POST /auth/device/confirmation',
    'GET /auth/session', 'GET /auth/boards', 'POST /auth/boards/link', 'POST /auth/machines', 'GET /auth/machines', 'POST /auth/coordinators', 'GET /auth/tokens', 'POST /auth/tokens', 'POST /auth/tokens/revoke']);

  /** Resolve a bearer or cookie credential; cookie writes require an exact trusted Origin. */
  function token(req, write = false) {
    const authorization = req.headers.authorization;
    if (authorization) {
      const match = /^Bearer ((?:ps_|pa_|pm_)[A-Za-z0-9_-]{43})$/.exec(authorization);
      if (!match) throw new Refused('AUTH_REQUIRED', 'send a current relay bearer credential');
      return match[1];
    }
    const session = cookie(req, 'pb_session');
    if (write && req.headers.origin !== origin.origin) throw new Refused('BAD_ORIGIN', 'send cookie-authorized writes from the relay origin');
    if (session !== undefined && !/^ps_[A-Za-z0-9_-]{43}$/.test(session)) throw new Refused('AUTH_REQUIRED', 'sign in to the relay in this browser');
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
        const input = await body(req);
        const grant = await auth.beginDevice(input);
        if (grant.confirmationTicket) {
          grant.confirmationURL = new URL('/auth/device/confirm#' + encodeURIComponent(grant.confirmationTicket), origin).href;
          delete grant.confirmationTicket;
        }
        json(res, 200, grant);
      } else if (route === 'POST /auth/device/poll') {
        const input = await body(req);
        json(res, 200, await auth.pollDevice(input.ticket));
      } else if (route === 'POST /auth/device/cancel') {
        const input = await body(req);
        json(res, 200, await auth.cancelDevice(input.ticket));
      } else if (route === 'GET /auth/device/confirm') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        res.end(deviceConfirmationPage());
      } else if (route === 'POST /auth/device/confirmation/open') {
        if (req.headers.origin !== origin.origin) throw new Refused('BAD_ORIGIN', 'open a device confirmation from the relay origin');
        const input = await body(req);
        const flow = auth.openDeviceConfirmation(input.ticket);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Set-Cookie': 'pb_device_confirmation=' + flow.binding + '; Path=/auth/device; HttpOnly; SameSite=Strict; Max-Age=' + flow.cookieMaxAge + secure });
        res.end(JSON.stringify({ version: 1, opened: true }));
      } else if (route === 'POST /auth/device/confirmation/status') {
        if (req.headers.origin !== origin.origin) throw new Refused('BAD_ORIGIN', 'read a device confirmation from the relay origin');
        const input = await body(req);
        json(res, 200, auth.deviceConfirmationStatus(input.ticket, cookie(req, 'pb_device_confirmation')));
      } else if (route === 'POST /auth/device/confirmation') {
        if (req.headers.origin !== origin.origin) throw new Refused('BAD_ORIGIN', 'send cookie-authorized confirmation from the relay origin');
        const input = await body(req);
        json(res, 200, await auth.confirmDevice(input.ticket, cookie(req, 'pb_device_confirmation'), input.decision));
      } else if (route === 'GET /auth/session') {
        json(res, 200, { session: await auth.authenticate(token(req), { ...(url.searchParams.has('board') ? { board: url.searchParams.get('board') } : {}) }) });
      } else if (route === 'GET /auth/boards') {
        json(res, 200, { boards: await auth.boardsFor(token(req)) });
      } else if (route === 'POST /auth/boards/link') {
        const bearer = token(req, true);
        const input = await body(req);
        json(res, 200, { board: await auth.linkBoard(bearer, input.board, input.repository, Infinity, input.replaces ?? null) });
      } else if (route === 'GET /auth/machines') {
        json(res, 200, { machines: await auth.listMachines(token(req), url.searchParams.get('board')) });
      } else if (route === 'POST /auth/machines') {
        const bearer = token(req, true);
        json(res, 201, await auth.issueMachine(bearer, await body(req)));
      } else if (route === 'POST /auth/coordinators') {
        const bearer = token(req, true);
        json(res, 201, await auth.issueCoordinator(bearer, await body(req)));
      } else if (route === 'GET /auth/tokens') {
        const bearer = token(req);
        const board = url.searchParams.get('board');
        json(res, 200, { tokens: await auth.listTokens(bearer, board), coordinatorEvents: await auth.coordinatorEvents(bearer, board) });
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
      const status = code === 'RELAY_BOARD_DELETED' ? 410 : code === 'BOARD_NOT_LINKED' ? 404 : code === 'AUTH_REQUIRED' ? 401 : ['DEVICE_REVOKED', 'NO_REPO_ACCESS', 'TOKEN_BOARD', 'TOKEN_NOT_OWNED', 'HUMAN_REQUIRED', 'BAD_ORIGIN', 'WRITE_REQUIRED'].includes(code) ? 403 : code === 'GITHUB_RATE_LIMITED' ? 429 : code === 'GITHUB_UNAVAILABLE' ? 503 : code === 'INTERNAL_ERROR' ? 500 : 400;
      json(res, status, { error: { code, message, next: message } });
    }
    return true;
  };
}
