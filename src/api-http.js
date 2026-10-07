/** API v1's shared HTTP boundary; local and relay adapters supply the same board operations (A2). */
import { Refused } from './refused.js';
import { refusalDocument } from './json.js';

const BODY_BYTES = 100_000;

/** Keep unexpected internal failures out of the public refusal document. */
function refusal(error) {
  return refusalDocument(error instanceof Refused ? error : new Refused('SERVICE_ERROR', 'the board service could not complete the call; retry or check the service'));
}

/** Emit exactly one versioned JSON response with no caching or content sniffing. */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ version: 1, ...value }));
}

/** Read a bounded JSON object, draining oversize requests so a refusal reaches the caller. */
async function readBody(req, { maxBytes = BODY_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20_000_000) throw new TypeError('API body limit needs a positive safe integer no larger than twenty million');
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new Refused('BAD_REQUEST', 'send an application/json object as the request body');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw new Refused('BAD_REQUEST', 'the body exceeds ' + maxBytes + ' bytes; send one move or request at a time');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refused('BAD_REQUEST', 'the body is not JSON; send an application/json object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused('BAD_REQUEST', 'the body needs a JSON object; send one move or request at a time');
  return value;
}

/** Reject unsafe sequence coercion while retaining the CLI's empty-cursor default. */
function eventCursor(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Refused('BAD_CURSOR', 'after and Last-Event-ID need a nonnegative integer; use the last event id received');
  return Number(value);
}

/** A supplied state cursor is an integer, so unlike an omitted events cursor, blank is invalid. */
function seenCursor(value) {
  if (value === '') throw new Refused('BAD_CURSOR', 'seen needs a nonnegative integer; use the last shout id you have seen');
  return eventCursor(value);
}

/** Create the common API router; an adapter controls authorization and board storage. */
export function createApiHandler(adapter, { pollMs = 200 } = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) throw new Refused('API_POLL', 'use a poll interval from 10 to 60000 milliseconds');
  const streams = new Set();

  /** Replay and follow records, respecting slow clients and revocation between polls. */
  async function stream(req, res, board, who, after, initial) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.write(': API v1\n\n');
    streams.add(res);
    let closed = false;
    let busy = false;
    let blocked = false;
    let timer;
    /** Remove this stream and its timer once the client disconnects or access is revoked. */
    function stop() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.delete(res);
      res.end();
    }
    /** Deliver only records after the latest delivered sequence, with no overlapping polls. */
    async function send() {
      if (closed || busy || blocked) return;
      busy = true;
      try {
        who = await adapter.authenticate(req, { board: board.id, write: false });
        const records = initial ?? await adapter.events(board, after, who);
        initial = null;
        for (const event of records) {
          if (closed) break;
          after = event.event_id;
          if (!res.write('id: ' + after + '\ndata: ' + JSON.stringify({ version: 1, event }) + '\n\n')) { blocked = true; break; }
        }
      } catch (error) {
        if (!closed) res.write('event: error\ndata: ' + JSON.stringify(refusal(error)) + '\n\n');
        stop();
      } finally { busy = false; }
    }
    res.once('close', stop);
    res.on('drain', () => { blocked = false; void send(); });
    timer = setInterval(send, pollMs);
    timer.unref();
    await send();
  }

  /** Route a request through the adapter and keep every HTTP response inside API v1. */
  async function handle(req, res) {
    try {
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { throw new Refused('BAD_REQUEST', 'use a valid path under /api/v1/boards'); }
      const route = /^\/api\/v1\/boards\/([^/]+)\/(state|events|moves|requests|code)$/.exec(url.pathname);
      const who = await adapter.authenticate(req, { board: route?.[1] ?? null, write: req.method === 'POST' });
      if (req.method === 'GET' && url.pathname === '/api/v1/boards') {
        const listing = await adapter.boards(who);
        return json(res, 200, Array.isArray(listing) ? { boards: listing } : listing);
      }
      if (!route) return json(res, 404, refusal(new Refused('NO_ENDPOINT', 'no API v1 endpoint here; use /api/v1/boards and a board state, code, events, moves or requests path')));
      const board = await adapter.board(route[1], who);
      if (req.method === 'GET' && route[2] === 'state') {
        const seen = url.searchParams.has('seen') ? seenCursor(url.searchParams.get('seen')) : null;
        return json(res, 200, { state: await adapter.state(board, who, seen) });
      }
      if (req.method === 'GET' && route[2] === 'code') {
        if (typeof adapter.code !== 'function') throw new Refused('CODE_NOT_AVAILABLE', 'this API adapter does not provide committed-code previews; use the local view or a local API server');
        const ref = /^([^:@]+):(\d+)(?:-(\d+))?@([0-9a-f]{7,40})$/.exec(url.searchParams.get('ref') ?? '');
        if (!ref) throw new Refused('BAD_REF', 'use ref=path:lines@commit, such as src/serve.js:12-30@be4356b');
        const before = (url.searchParams.get('before') ?? '').slice(-2000);
        return json(res, 200, { code: await adapter.code(board, { path: ref[1], from: Number(ref[2]), to: Number(ref[3] ?? ref[2]), commit: ref[4], before }, who) });
      }
      if (req.method === 'GET' && route[2] === 'events') {
        const after = eventCursor(req.headers['last-event-id'] ?? url.searchParams.get('after'));
        const initial = await adapter.events(board, after, who);
        const live = String(req.headers.accept ?? '').split(',').some((part) => /^\s*text\/event-stream\s*(?:;|$)/i.test(part));
        if (live) return await stream(req, res, board, who, after, initial);
        return json(res, 200, { events: initial });
      }
      if (req.method === 'POST' && route[2] === 'moves') {
        const moved = await adapter.move(board, await readBody(req), who);
        return json(res, moved.status, moved.body);
      }
      if (req.method === 'POST' && route[2] === 'requests') return json(res, 200, await adapter.request(board, await readBody(req), who));
      return json(res, 400, refusal(new Refused('BAD_REQUEST', 'use GET for reads and POST for moves and requests')));
    } catch (error) {
      const status = apiStatus(error);
      if (!res.headersSent) json(res, status, refusal(error));
      else res.end();
    }
  }
  handle.close = () => { for (const res of streams) res.end(); };
  return handle;
}


/** Choose the same HTTP refusal class for local and sealed relay adapters. */
export function apiStatus(error) {
  return { AUTH_REQUIRED: 401, TOKEN_BOARD: 403, API_ORIGIN: 403, BAD_ORIGIN: 403, WRITE_REQUIRED: 403, NO_REPO_ACCESS: 403, NO_BOARD: 404, BOARD_NOT_LINKED: 404, NO_SNAPSHOT: 404, SNAPSHOT_REQUIRED: 409, SEQUENCE_REPEAT: 409, SEQUENCE_GAP: 409 }[error.code] ?? (error instanceof Refused ? 400 : 500);
}

// Relay-only snapshot/delete routes reuse the exact shared bounded-body and refusal boundary.
export { json as apiJson, refusal as apiRefusal, readBody as readApiBody };
