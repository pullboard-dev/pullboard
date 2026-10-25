/** API v1's shared HTTP boundary; local and relay adapters supply the same board operations (A2). */
import { Refused } from './refused.js';
import { relayStorage } from './relay-storage.js';
import { refusalDocument } from './json.js';
import { withGitFacts } from './git.js';
import { PAIR_PACKAGE_BODY_BYTES } from './relay-limits.js';

const BODY_BYTES = 100_000;

/** Keep unexpected internal failures out of the public refusal document. */
function refusal(error) {
  const document = refusalDocument(error instanceof Refused ? error : new Refused('SERVICE_ERROR', 'the board service could not complete the call; retry or check the service'));
  const storage = error instanceof Refused && error.code === 'ACCOUNT_STORAGE_LIMIT' ? relayStorage(error.storage) : null;
  if (storage) document.error.storage = storage;
  return document;
}

/** Emit exactly one versioned JSON response with no caching or content sniffing. */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ version: 1, ...value }));
}

/** Emit a local adapter's pre-serialized state inside the unchanged API v1 envelope. */
function jsonState(res, status, state, eventLogVersion) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  const version = eventLogVersion === undefined ? '' : ',"eventLogVersion":' + JSON.stringify(eventLogVersion);
  res.end('{"version":1,"state":' + state + version + '}');
}

/** Read a bounded JSON object, draining oversize requests so a refusal reaches the caller. */
async function readBody(req, { maxBytes = BODY_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PAIR_PACKAGE_BODY_BYTES) throw new TypeError('API body limit needs a positive safe integer within the shared request limit');
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

/** A delta's base is the sequence of a state the client holds; unlike an omitted events cursor, blank is invalid. */
function sinceCursor(value) {
  if (value === '') throw new Refused('BAD_CURSOR', "since needs a nonnegative integer; use the sequence of the state you hold");
  return eventCursor(value);
}

/** Read a many-board stream's board ids: at least one, each named once (A2). */
function boardList(value) {
  const ids = String(value ?? '').split(',');
  if (ids.some((id) => !id)) throw new Refused('BAD_REQUEST', 'name the boards to follow: /api/v1/events?boards=<id>,<id> with ids from GET /api/v1/boards');
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated) throw new Refused('BAD_REQUEST', `board ${repeated} is named twice; name each board once`);
  return ids;
}

/**
 * Read a many-board cursor: board:sequence pairs joined by commas, one per board. A followed board
 * the cursor leaves out starts from its first event, and a pair for a board not followed is ignored.
 */
function boardCursors(value) {
  const cursors = new Map();
  if (value === null || value === undefined || value === '') return cursors;
  for (const part of String(value).split(',')) {
    const pair = /^(.+):(\d+)$/.exec(part);
    if (!pair || !Number.isSafeInteger(Number(pair[2])) || cursors.has(pair[1])) {
      throw new Refused('BAD_CURSOR', 'a many-board cursor is board:sequence pairs joined by commas, each board once; use the last event id received');
    }
    cursors.set(pair[1], Number(pair[2]));
  }
  return cursors;
}

/** Name the board a many-board stream refused, unless the refusal already does (A2). */
function namedRefusal(id, error) {
  if (!(error instanceof Refused) || error.message.includes(id)) return error;
  return new Refused(error.code, `board ${id}: ${error.message.replace(/^\[[A-Z0-9_]+\] /u, '')}`, error.next);
}

/** Whether a request asks for a live text/event-stream response rather than JSON. */
function wantsLive(req) {
  return String(req.headers.accept ?? '').split(',').some((part) => /^\s*text\/event-stream\s*(?:;|$)/i.test(part));
}

/** Read a state request's detail choice: item summaries, every item in full, or null for the server's default (A2). */
function stateDetail(value) {
  if (value === null) return null;
  if (value === 'full' || value === 'summary') return value;
  throw new Refused('BAD_REQUEST', 'state detail is full or summary; use detail=full for every item in full, or detail=summary for item summaries');
}

/** Create the common API router; an adapter controls authorization and board storage. */
export function createApiHandler(adapter, { pollMs = 200 } = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) throw new Refused('API_POLL', 'use a poll interval from 10 to 60000 milliseconds');
  const streams = new Set();

  /**
   * Open one board for a stream: its watcher and revision come before its replay, so a change
   * between them is still signalled.
   */
  async function openFollow(board, who, after) {
    const watcher = await adapter.watchRevision?.(board, who);
    try {
      const lastRevision = await watcher?.revision();
      const initial = await adapter.events(board, after, who);
      return { board, who, after, initial, watcher, lastRevision, lastWarning: null };
    } catch (error) {
      watcher?.close();
      throw error;
    }
  }

  /** Preserve the legacy primary warning while carrying additional independent notices. */
  async function warningsFor(board, who) {
    const primary = await adapter.warning?.(board, who);
    const additional = await adapter.warnings?.(board, who);
    return [primary, ...(Array.isArray(additional) ? additional : [])].filter(Boolean);
  }

  /**
   * Replay and follow one or more boards' records on one response, respecting slow clients and
   * revocation between polls. A tagged stream names each frame's board, and each ordinary
   * event's id carries every followed board's cursor, so one Last-Event-ID resumes them all.
   */
  async function stream(req, res, follows, tagged) {
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
      for (const follow of follows) follow.watcher?.close();
      res.end();
    }
    /** Serialize one frame's data, naming its board on a tagged stream. */
    const frame = (follow, fields) => JSON.stringify(tagged ? { version: 1, board: follow.board.id, ...fields } : { version: 1, ...fields });
    /** The id of an ordinary event: its sequence, or every followed board's cursor on a tagged stream. */
    const eventId = (follow) => tagged ? follows.map((each) => each.board.id + ':' + each.after).join(',') : String(follow.after);
    /** Deliver only records after each board's latest delivered sequence, with no overlapping polls. */
    async function send() {
      return withGitFacts(async () => {
        if (closed || busy || blocked) return;
        busy = true;
        let current = null;
        try {
          for (const follow of follows) {
            current = follow;
            follow.who = await adapter.authenticate(req, { board: follow.board.id, write: false });
            const warnings = await warningsFor(follow.board, follow.who);
            const serialized = warnings.length ? JSON.stringify(warnings) : null;
            if (serialized !== follow.lastWarning) {
              follow.lastWarning = serialized;
              for (const warning of warnings) {
                if (!res.write('event: warning\ndata: ' + frame(follow, { warning }) + '\n\n')) { blocked = true; return; }
              }
            }
            const records = follow.initial ?? await adapter.events(follow.board, follow.after, follow.who);
            follow.initial = null;
            for (const event of records) {
              if (closed) break;
              follow.after = event.event_id;
              if (!res.write('id: ' + eventId(follow) + '\ndata: ' + frame(follow, { event }) + '\n\n')) { blocked = true; break; }
            }
            if (closed || blocked) return;
            if (follow.watcher) {
              const revision = await follow.watcher.revision();
              if (revision !== follow.lastRevision) {
                follow.lastRevision = revision;
                if (!res.write('event: changed\ndata: ' + frame(follow, { event: { event_kind: 'changed' } }) + '\n\n')) { blocked = true; return; }
              }
            }
          }
        } catch (error) {
          if (!closed) res.write('event: error\ndata: ' + JSON.stringify(refusal(tagged && current ? namedRefusal(current.board.id, error) : error)) + '\n\n');
          stop();
        } finally { busy = false; }
      });
    }
    res.once('close', stop);
    res.on('drain', () => { blocked = false; void send(); });
    timer = setInterval(send, pollMs);
    timer.unref();
    await send();
  }

  /** Route a request through the adapter and keep every HTTP response inside API v1. */
  async function handle(req, res) {
    return withGitFacts(() => route(req, res));
  }

  /** Handle one request under a fresh Git-fact scope so a long-lived server observes later refs. */
  async function route(req, res) {
    try {
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { throw new Refused('BAD_REQUEST', 'use a valid path under /api/v1/boards'); }
      const route = /^\/api\/v1\/boards\/([^/]+)\/(state|events|moves|requests|code|tokens|items)$/.exec(url.pathname);
      const shoutRoute = /^\/api\/v1\/boards\/([^/]+)\/shouts\/([^/]+)$/.exec(url.pathname);
      const itemRoute = /^\/api\/v1\/boards\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
      const boardId = route?.[1] ?? shoutRoute?.[1] ?? itemRoute?.[1] ?? null;
      const who = await adapter.authenticate(req, { board: boardId, write: req.method === 'POST' });
      if (url.pathname === '/api/v1/settings') {
        if (req.method !== 'GET') throw new Refused('READ_ONLY', 'settings are read-only here; use the supported settings commands');
        if (typeof adapter.settings !== 'function') throw new Refused('SETTINGS_NOT_AVAILABLE', 'read machine and repository settings from the local API');
        return json(res, 200, await adapter.settings(url.searchParams.get('board'), who));
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/boards') {
        const listing = await adapter.boards(who);
        return json(res, 200, Array.isArray(listing) ? { boards: listing } : listing);
      }
      if (url.pathname === '/api/v1/events') {
        // One connection follows many boards, so a group view stays inside a browser's six per origin.
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'follow boards with GET /api/v1/events?boards=<id>,<id>');
        if (!wantsLive(req)) throw new Refused('BAD_REQUEST', "the many-board events path is a live stream; send Accept: text/event-stream, or read one board's events at /api/v1/boards/:board/events");
        const ids = boardList(url.searchParams.get('boards'));
        const cursors = boardCursors(req.headers['last-event-id'] ?? url.searchParams.get('after'));
        const follows = [];
        try {
          for (const id of ids) {
            try {
              const reader = await adapter.authenticate(req, { board: id, write: false });
              follows.push(await openFollow(await adapter.board(id, reader), reader, cursors.get(id) ?? 0));
            } catch (error) {
              throw namedRefusal(id, error);
            }
          }
          return await stream(req, res, follows, true);
        } catch (error) {
          for (const follow of follows) follow.watcher?.close();
          throw error;
        }
      }
      if (!route && !shoutRoute && !itemRoute) return json(res, 404, refusal(new Refused('NO_ENDPOINT', 'no API v1 endpoint here; use /api/v1/boards and a board state, item, shout, code, events, moves or requests path')));
      const board = await adapter.board(boardId, who);
      if (itemRoute) {
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read an item with GET; use a board move to change it');
        const rawId = itemRoute[2];
        if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new Refused('BAD_REQUEST', 'item needs a positive integer id; use an id from the board state');
        if (typeof adapter.item !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', "this API adapter does not provide item detail reads; use its board state, which carries each item's full detail");
        const item = await adapter.item(board, Number(rawId), who);
        if (!item) return json(res, 404, refusal(new Refused('NO_ITEM', `no item #${rawId} on this board; use an id from the board state`)));
        return json(res, 200, { item });
      }
      if (req.method === 'GET' && route?.[2] === 'items') {
        if (typeof adapter.search !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', "this API adapter does not provide item search; use its board state, which carries each item's full detail");
        return json(res, 200, { ids: await adapter.search(board, url.searchParams.get('q') ?? '', who) });
      }
      if (req.method === 'GET' && shoutRoute) {
        const rawId = shoutRoute[2];
        if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new Refused('BAD_REQUEST', 'shout needs a positive integer id; use the id from the event or recent state');
        if (typeof adapter.shout !== 'function') throw new Refused('SHOUT_NOT_AVAILABLE', 'this API adapter does not provide addressed shout reads');
        return json(res, 200, { shout: await adapter.shout(board, Number(rawId), who) });
      }
      if (shoutRoute) throw new Refused('BAD_REQUEST', 'read an addressed shout with GET; use a board move to create or answer shouts');
      if (route[2] === 'tokens') {
        if (typeof adapter.tokens !== 'function' || typeof adapter.revokeToken !== 'function') {
          throw new Refused('TOKENS_NOT_AVAILABLE', "manage this board's agent tokens in its local view or signed-in relay account");
        }
        if (req.method === 'GET') return json(res, 200, { tokens: await adapter.tokens(board, who) });
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (Object.keys(body).some((key) => key !== 'id') || typeof body.id !== 'string') {
            throw new Refused('BAD_REQUEST', "token revocation takes only the opaque id from this board's token list");
          }
          return json(res, 200, await adapter.revokeToken(board, body.id, who));
        }
      }
      if (req.method === 'GET' && route[2] === 'state') {
        const seen = url.searchParams.has('seen') ? seenCursor(url.searchParams.get('seen')) : null;
        const options = { detail: stateDetail(url.searchParams.get('detail')) };
        if (url.searchParams.has('since')) {
          const since = sinceCursor(url.searchParams.get('since'));
          if (options.detail === 'full') throw new Refused('BAD_REQUEST', 'a delta brings item summaries up to date; use since=N without detail=full');
          if (typeof adapter.delta !== 'function') throw new Refused('DELTA_NOT_AVAILABLE', 'this API adapter does not answer since=N; use its board state');
          return json(res, 200, await adapter.delta(board, who, seen, { since, eventLogVersion: url.searchParams.get('eventLogVersion') }));
        }
        if (typeof adapter.stateJson === 'function') {
          const state = await adapter.stateJson(board, who, seen, options);
          if (typeof state !== 'string') throw new TypeError('the local state serializer must return JSON text');
          const eventLogVersion = await adapter.eventLogVersion?.(board, who);
          return jsonState(res, 200, state, eventLogVersion);
        }
        const state = await adapter.state(board, who, seen, options);
        const eventLogVersion = await adapter.eventLogVersion?.(board, who);
        return json(res, 200, { state, ...(eventLogVersion === undefined ? {} : { eventLogVersion }) });
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
        if (wantsLive(req)) {
          const follow = await openFollow(board, who, after);
          try {
            return await stream(req, res, [follow], false);
          } catch (error) {
            follow.watcher?.close();
            throw error;
          }
        }
        const initial = await adapter.events(board, after, who);
        const warnings = await warningsFor(board, who);
        const eventLogVersion = await adapter.eventLogVersion?.(board, who);
        return json(res, 200, { events: initial, ...(eventLogVersion === undefined ? {} : { eventLogVersion }),
          ...(warnings.length ? { warning: warnings[0], ...(warnings.length > 1 ? { warnings: warnings.slice(1) } : {}) } : {}) });
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


/**
 * Apply a state delta (GET .../state?since=N) to the state it extends, giving the state a fresh
 * snapshot would. It recomputes nothing: whole fields replace, and keyed lists take their changed
 * entries and, when given, their new key order (A2).
 *
 * @param {any} state
 * @param {{ replace: object, merge: Record<string, { key: string, set: object[], ids?: (string|number)[] }>, remove?: string[] }} delta
 * @returns {any}
 */
export function applyStateDelta(state, delta) {
  const next = { ...state, ...delta.replace };
  for (const field of delta.remove ?? []) delete next[field];
  for (const [field, { key, set, ids }] of Object.entries(delta.merge)) {
    const entries = new Map((state[field] ?? []).map((entry) => [entry[key], entry]));
    for (const entry of set) entries.set(entry[key], entry);
    next[field] = (ids ?? (state[field] ?? []).map((entry) => entry[key])).map((id) => entries.get(id));
  }
  return next;
}

/** Choose the same HTTP refusal class for local and sealed relay adapters. */
export function apiStatus(error) {
  if (error instanceof Refused && error.code === 'ACCOUNT_STORAGE_LIMIT') return 507;
  return { GITHUB_UNAVAILABLE: 503, RELAY_BOARD_DELETED: 410, AUTH_REQUIRED: 401, DEVICE_REVOKED: 403, TOKEN_BOARD: 403, API_ORIGIN: 403, BAD_ORIGIN: 403, WRITE_REQUIRED: 403, HUMAN_REQUIRED: 403, NO_REPO_ACCESS: 403, NO_BOARD: 404, NO_SHOUT: 404, BOARD_NOT_LINKED: 404, NO_SNAPSHOT: 404, BASELINE_EXISTS: 412, SNAPSHOT_REQUIRED: 409, SEQUENCE_REPEAT: 409, SEQUENCE_GAP: 409 }[error.code] ?? (error instanceof Refused ? 400 : 500);
}

// Relay-only snapshot/delete routes reuse the exact shared bounded-body and refusal boundary.
export { json as apiJson, refusal as apiRefusal, readBody as readApiBody };
