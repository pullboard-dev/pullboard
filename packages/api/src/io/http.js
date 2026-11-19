/** API v1's shared HTTP boundary; local and relay adapters supply the same board operations (A2). */
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { Refused } from '../../../kernel/index.js';
import { relayStorage } from '../../../link/index.js';
import { withGitFacts } from '../../../git/index.js';
import { PAIR_PACKAGE_BODY_BYTES } from '../../../link/index.js';

const fs = fileSystemAdapter();

const BODY_BYTES = 100_000;
/** Gzip a reply off the request thread, in the libuv pool, so a big state's compression never stalls other requests. */
const gzipText = promisify(gzip);

/** Keep unexpected internal failures out of the public refusal document, and write them to stderr; the caller supplies the renderer. */
function refusalFor(refusalDocument, error) {
  // The body stays generic, but whoever runs the service needs the cause: log the original message and stack before answering.
  if (!(error instanceof Refused)) process.stderr.write(`pullboard service error: ${error?.stack ?? String(error)}\n`);
  const document = refusalDocument(error instanceof Refused ? error : new Refused('SERVICE_ERROR', 'the board service could not complete the call; retry or check the service'));
  const storage = error instanceof Refused && error.code === 'ACCOUNT_STORAGE_LIMIT' ? relayStorage(error.storage) : null;
  if (storage) document.error.storage = storage;
  const size = error instanceof Refused && error.code === 'MOVE_TOO_LARGE' ? error.moveLimit : null;
  if (Number.isSafeInteger(size?.moveBytes) && Number.isSafeInteger(size?.limit) && size.limit > 0 && size.moveBytes > size.limit) {
    document.error.moveLimit = { moveBytes: size.moveBytes, limit: size.limit };
  }
  return document;
}

/** Emit exactly one versioned JSON response with no caching or content sniffing. */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ version: 1, ...value }));
}

/** A local adapter's pre-serialized state inside the unchanged API v1 envelope. */
function stateText(state, eventLogVersion) {
  const version = eventLogVersion === undefined ? '' : ',"eventLogVersion":' + JSON.stringify(eventLogVersion);
  return '{"version":1,"state":' + state + version + '}';
}

/**
 * Send a state reply. A tagging server (the local one) tags it with a digest of its text and answers
 * 304 Not Modified with no body when the caller's If-None-Match already names it, so a poll of an
 * unchanged board sends nothing (#1040). The digest blanks the clock readings stamped afresh on every
 * read (flow asOf, queue ageMinutes), as the view's own board comparison does (#644). Replies stay
 * no-store: the browser never answers a poll from its cache, so a page that wants the newest clock
 * readings still gets them by not asking If-None-Match. A request that accepts gzip gets the text gzip-encoded under the
 * same validator, which names the board state, not its bytes: a big board's 5-8 MB of JSON goes out as about 1 MB.
 */
async function sendState(req, res, text, tagged, validator = text, reportValidator) {
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
  headers.vary = [res.getHeader('vary'), 'Accept-Encoding'].filter(Boolean).join(', ');
  if (typeof reportValidator === 'string' && /^[a-f0-9]{64}:[0-9]+$/u.test(reportValidator)) headers['x-pullboard-report-validator'] = reportValidator;
  if (tagged) {
    const board = validator.replace(/"(asOf|ageMinutes|observedAt)":(?:"[^"]*"|[-+.0-9eE]+|null)/gu, '"$1":null');
    Object.assign(headers, { etag: '"' + createHash('sha256').update(board).digest('base64url').slice(0, 32) + '"' });
    const held = String(req.headers['if-none-match'] ?? '').split(',').map((tag) => tag.trim().replace(/^W\//u, ''));
    if (held.includes(headers.etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  if (acceptsGzip(req.headers['accept-encoding'])) {
    const body = await gzipText(text);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', ...headers });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

/** Whether an Accept-Encoding header takes gzip: named, or covered by `*`, with a q above 0 (RFC 9110 12.5.3). */
function acceptsGzip(header) {
  let named = null, any = null;
  for (const part of String(header ?? '').split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((param) => /^\s*q\s*=\s*([0-9.]+)\s*$/u.exec(param)).find(Boolean);
    const weight = q ? Number(q[1]) : 1;
    if (coding === 'gzip' || coding === 'x-gzip') named = weight;
    else if (coding === '*') any = weight;
  }
  return (named ?? any ?? 0) > 0;
}

/**
 * Read a bounded JSON object, draining oversize requests so a refusal reaches the caller. An upload (uploadRefusal)
 * answers an oversize body with the structured BAD_UPLOAD size refusal: the measured bytes and the stated limit, so the
 * machine can name the board instead of waiting on a plain BAD_REQUEST (#1196). A move (moveRefusal) answers an oversize
 * body with the structured MOVE_TOO_LARGE refusal: the move's measured bytes and the stated limit, so the sender can park
 * it and name the recovery instead of retrying a move that can never fit (#6696).
 */
async function readBody(req, { maxBytes = BODY_BYTES, uploadRefusal = false, moveRefusal = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PAIR_PACKAGE_BODY_BYTES) throw new TypeError('API body limit needs a positive safe integer within the shared request limit');
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new Refused('BAD_REQUEST', 'send an application/json object as the request body');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes && uploadRefusal) {
    const error = new Refused('BAD_UPLOAD', 'the upload body exceeds the relay limit; send a smaller snapshot');
    error.snapshotLimit = { sealedBytes: size, limit: maxBytes };
    throw error;
  }
  if (size > maxBytes && moveRefusal) {
    const error = new Refused('MOVE_TOO_LARGE', `this move is ${size} bytes, over the relay limit of ${maxBytes} bytes`);
    error.moveLimit = { moveBytes: size, limit: maxBytes };
    throw error;
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

/** The most events one read returns: absent means all, otherwise a positive integer. */
function eventLimit(value) {
  if (value === null || value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Refused('BAD_REQUEST', 'limit needs a positive integer; read the next page with after=<last event id>');
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
export function createApiHandler(adapter, { pollMs = 200, tagState = false, bodyBytes = {} } = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) throw new Refused('API_POLL', 'use a poll interval from 10 to 60000 milliseconds');
  if (typeof adapter?.refusalDocument !== 'function') throw new TypeError('createApiHandler needs the caller\'s refusalDocument renderer');
  /** Render one refusal with the injected renderer. */
  const refusal = (error) => refusalFor(adapter.refusalDocument, error);
  const streams = new Set();

  /**
   * Open one board for a stream: its watcher and revision come before its replay, so a change
   * between them is still signalled.
   */
  async function openFollow(board, who, after, { signals = true } = {}) {
    const watcher = await adapter.watchRevision?.(board, who, { signals });
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
    let dirty = false;
    let timer;
    const subscriptions = [];
    /** Remove this stream and its timer once the client disconnects or access is revoked. */
    function stop() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.delete(res);
      for (const unsubscribe of subscriptions) unsubscribe();
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
        if (closed) return;
        if (busy || blocked) { dirty = true; return; }
        busy = true; dirty = false;
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
        } finally { busy = false; if (dirty && !closed && !blocked) queueMicrotask(send); }
      });
    }
    res.once('close', stop);
    res.on('drain', () => { blocked = false; void send(); });
    for (const follow of follows) if (follow.watcher?.subscribe) subscriptions.push(follow.watcher.subscribe(error => {
      if (error) { if (!closed) res.write('event: error\ndata: ' + JSON.stringify(refusal(error)) + '\n\n'); stop(); }
      else void send();
    }));
    // Remote/legacy adapters without a native notification port retain their existing transport contract.
    if (follows.some(follow => !follow.watcher?.subscribe)) { timer = setInterval(send, pollMs); timer.unref(); }
    await send();
  }

  /** Route a request through the adapter and keep every HTTP response inside API v1. */
  /**
   * Stream the board's cached trunk pack for one commit, so cold runners share one pack-objects on the coordinator.
   * Why an open descriptor: a newer trunk commit deletes older packs, and an open file still streams whole.
   */
  async function sendTrunkPack(req, res, board, commit, who) {
    if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read a trunk pack with GET /api/v1/boards/:board/trunk/<commit>.pack');
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Refused('BAD_REQUEST', 'a trunk pack needs a full hex commit id; use the commit the job names');
    if (typeof adapter.trunkPack !== 'function') return json(res, 404, refusal(new Refused('TRUNK_PACK_NOT_AVAILABLE', 'this board serves no trunk packs; fetch the commit from the trunk remote')));
    const served = await adapter.trunkPack(board, commit, who);
    if (!served) return json(res, 404, refusal(new Refused('NO_COMMIT', `the trunk has no commit ${commit}; fetch it from the trunk remote`)));
    const opened = await fs.promises.open(served.file, 'r');
    try {
      const { size } = await opened.stat();
      res.writeHead(200, { 'content-type': 'application/x-git-packed-objects', 'content-length': String(size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      await pipeline(opened.createReadStream({ autoClose: false }), res);
    } finally { await opened.close(); }
  }

  async function handle(req, res) {
    return withGitFacts(() => route(req, res));
  }

  /** Handle one request under a fresh Git-fact scope so a long-lived server observes later refs. */
  async function route(req, res) {
    try {
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { throw new Refused('BAD_REQUEST', 'use a valid path under /api/v1/boards'); }
      const route = /^\/api\/v1\/boards\/([^/]+)\/(state|finished|summary|events|moves|requests|code|tokens|items|cost-analytics|jobs)$/.exec(url.pathname);
      const shoutRoute = /^\/api\/v1\/boards\/([^/]+)\/shouts\/([^/]+)$/.exec(url.pathname);
      const proofRoute = /^\/api\/v1\/boards\/([^/]+)\/proofs\/([^/]+)$/.exec(url.pathname);
      const itemRoute = /^\/api\/v1\/boards\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
      const agentRoute = /^\/api\/v1\/boards\/([^/]+)\/agents\/([^/]+)$/.exec(url.pathname);
      const trunkRoute = /^\/api\/v1\/boards\/([^/]+)\/trunk\/([^/]+)\.pack$/.exec(url.pathname);
      const boardId = route?.[1] ?? shoutRoute?.[1] ?? itemRoute?.[1] ?? agentRoute?.[1] ?? proofRoute?.[1] ?? trunkRoute?.[1] ?? null;
      const who = await adapter.authenticate(req, { board: boardId, write: req.method === 'POST' });
      // Health answers on the request thread from what it holds, never through a handler, so a busy pool still answers it [A2,C7].
      if (url.pathname === '/api/v1/health') return json(res, 200, { ok: true, ...(await adapter.health?.(who)) });
      if (url.pathname === '/api/v1/settings') {
        if (req.method !== 'GET') throw new Refused('READ_ONLY', 'settings are read-only here; use the supported settings commands');
        if (typeof adapter.settings !== 'function') throw new Refused('SETTINGS_NOT_AVAILABLE', 'read machine and repository settings from the local API');
        return json(res, 200, await adapter.settings(url.searchParams.get('board'), who));
      }
      if (url.pathname === '/api/v1/decisions') {
        if (req.method !== 'GET') throw new Refused('READ_ONLY', "list decisions with GET; answer one through its own board's moves path");
        if (typeof adapter.decisions !== 'function') throw new Refused('DECISIONS_NOT_AVAILABLE', "this API adapter does not list a project's decisions; read each board's state, which carries its own");
        return json(res, 200, await adapter.decisions(url.searchParams.get('board'), who));
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
      if (!route && !shoutRoute && !itemRoute && !agentRoute && !proofRoute && !trunkRoute) return json(res, 404, refusal(new Refused('NO_ENDPOINT', 'no API v1 endpoint here; use /api/v1/boards and a board state, item, shout, code, events, moves or requests path')));
      // A runner's job call is served ahead of agent moves when the API is busy, its board lookup too (#10786).
      const board = await adapter.board(boardId, who, { runner: route?.[2] === 'jobs' });
      if (trunkRoute) return await sendTrunkPack(req, res, board, trunkRoute[2], who);
      if (proofRoute) {
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read a proof record with GET');
        const rawId = proofRoute[2];
        if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new Refused('BAD_REQUEST', 'proof needs a positive item id from the board state');
        if (typeof adapter.proof !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', 'this adapter does not provide detailed proof records; read them from the local API');
        const proof = await adapter.proof(board, Number(rawId), who);
        if (!proof) return json(res, 404, refusal(new Refused('NO_ITEM', `no proof record for item #${rawId} on this board`)));
        return json(res, 200, { proof });
      }
      if (agentRoute) {
        // One seat's lane and claims, read from the board's agent and item rows; the board state is never built for it [P7].
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read a seat with GET; use a board move to change it');
        if (typeof adapter.agent !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', 'this API adapter does not answer one seat on its own; use its board state');
        return json(res, 200, await adapter.agent(board, decodeURIComponent(agentRoute[2]), who));
      }
      if (itemRoute) {
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read an item with GET; use a board move to change it');
        const rawId = itemRoute[2];
        if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new Refused('BAD_REQUEST', 'item needs a positive integer id; use an id from the board state');
        if (typeof adapter.item !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', "this API adapter does not provide item detail reads; use its board state, which carries each item's full detail");
        const item = await adapter.item(board, Number(rawId), who);
        if (!item) return json(res, 404, refusal(new Refused('NO_ITEM', `no item #${rawId} on this board; use an id from the board state`)));
        return json(res, 200, { item });
      }
      if (route?.[2] === 'summary') {
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read a board summary with GET');
        if (typeof adapter.summary !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', "this API adapter does not serve board summaries; read its board state");
        const text = await adapter.summary(board, who);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
        return res.end(text);
      }
      if (route?.[2] === 'finished') {
        if (req.method !== 'GET') throw new Refused('BAD_REQUEST', 'read the finished items with GET');
        if (typeof adapter.finished !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', 'this API adapter does not serve finished items on their own; read its board state');
        return await sendState(req, res, await adapter.finished(board, who), false);
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
        if (url.searchParams.has('items')) {
          if (url.searchParams.get('items') !== 'compact' || options.detail === 'full' || url.searchParams.has('since')) {
            throw new Refused('BAD_REQUEST', 'items=compact is only for a summary snapshot; read ordinary deltas or use detail=full without compact items');
          }
          options.items = 'compact';
        }
        if (url.searchParams.has('finished')) {
          // A first load that shows open work first leaves out the verified and withdrawn items; GET .../finished sends them [A2,N26].
          if (url.searchParams.get('finished') !== 'omit' || options.items !== 'compact' || url.searchParams.has('since')) throw new Refused('BAD_REQUEST', 'finished=omit is only for a compact snapshot (items=compact); read ordinary deltas with since=N');
          options.finished = 'omit';
        }
        if (url.searchParams.has('kept')) {
          // A first load that catches up through deltas may take the state the server keeps, from before a later write [A2,C7].
          if (url.searchParams.get('kept') !== '1' || url.searchParams.has('since')) throw new Refused('BAD_REQUEST', 'kept=1 is only for a snapshot; read deltas with since=N and no kept');
          options.kept = true;
        }
        if (url.searchParams.has('since')) {
          const since = sinceCursor(url.searchParams.get('since'));
          if (options.detail === 'full') throw new Refused('BAD_REQUEST', 'a delta brings item summaries up to date; use since=N without detail=full');
          if (typeof adapter.delta !== 'function') throw new Refused('DELTA_NOT_AVAILABLE', 'this API adapter does not answer since=N; use its board state');
          const delta = await adapter.delta(board, who, seen, { since, eventLogVersion: url.searchParams.get('eventLogVersion') });
          return await sendState(req, res, JSON.stringify({ version: 1, ...delta }), tagState, undefined, delta.reportValidator);
        }
        if (typeof adapter.stateJson === 'function') {
          const encoded = await adapter.stateJson(board, who, seen, options);
          const state = typeof encoded === 'string' ? encoded : encoded?.json;
          if (typeof state !== 'string' || encoded?.validator !== undefined && typeof encoded.validator !== 'string') throw new TypeError('the local state serializer must return JSON text and optional internal validator text');
          const eventLogVersion = await adapter.eventLogVersion?.(board, who);
          return await sendState(req, res, stateText(state, eventLogVersion), tagState,
            typeof encoded?.validator === 'string' ? stateText(encoded.validator, eventLogVersion) : undefined, encoded?.reportValidator);
        }
        const state = await adapter.state(board, who, seen, options);
        const eventLogVersion = await adapter.eventLogVersion?.(board, who);
        return await sendState(req, res, JSON.stringify({ version: 1, state, ...(eventLogVersion === undefined ? {} : { eventLogVersion }) }), tagState);
      }
      if (req.method === 'GET' && route[2] === 'cost-analytics') {
        if (typeof adapter.costAnalytics !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', 'cost analytics is available only from the private local board');
        return json(res, 200, { costAnalytics: await adapter.costAnalytics(board, url.searchParams.get('window') ?? '30d', who) });
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
          // signals=none asks for events only: no changed notification, so no per-write state revision is built for this client.
          const follow = await openFollow(board, who, after, { signals: url.searchParams.get('signals') !== 'none' });
          try {
            return await stream(req, res, [follow], false);
          } catch (error) {
            follow.watcher?.close();
            throw error;
          }
        }
        const initial = await adapter.events(board, after, who, eventLimit(url.searchParams.get('limit')));
        const warnings = await warningsFor(board, who);
        const eventLogVersion = await adapter.eventLogVersion?.(board, who);
        const checkpointEpoch = await adapter.checkpointEpoch?.(board, who);
        return json(res, 200, { events: initial, ...(eventLogVersion === undefined ? {} : { eventLogVersion }), ...(checkpointEpoch ? { checkpointEpoch } : {}),
          ...(warnings.length ? { warning: warnings[0], ...(warnings.length > 1 ? { warnings: warnings.slice(1) } : {}) } : {}) });
      }
      if (req.method === 'POST' && route[2] === 'moves') {
        const moved = await adapter.move(board, await readBody(req, { moveRefusal: true, ...(bodyBytes.moves ? { maxBytes: bodyBytes.moves } : {}) }), who);
        return json(res, moved.status, moved.body);
      }
      if (route[2] === 'jobs') {
        // The runner job queue: a runner claims by capability, renews its lease and posts its receipt, all by POST [P7].
        if (req.method !== 'POST' || typeof adapter.jobs !== 'function') throw new Refused('JOBS_NOT_AVAILABLE', 'POST one job queue call (claim, renew, release or receipt) to a board that serves its runner job queue');
        return json(res, 200, await adapter.jobs(board, await readBody(req), who));
      }
      if (req.method === 'POST' && route[2] === 'requests') return json(res, 200, await adapter.request(board, await readBody(req, bodyBytes.requests ? { maxBytes: bodyBytes.requests } : undefined), who));
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
 * @param {{ replace: object, merge: Record<string, { key: string, set: object[], ids?: (string|number)[] }>, milestonePace?: object, remove?: string[] }} delta
 * @returns {any}
 */
export function applyStateDelta(state, delta) {
  const next = { ...state, ...delta.replace };
  for (const field of delta.remove ?? []) delete next[field];
  for (const [field, { key, set, ids }] of Object.entries(delta.merge)) {
    const entries = new Map((state[field] ?? []).map((entry) => [entry[key], entry]));
    for (const entry of set) entries.set(entry[key], entry);
    // An open-first client holds no finished items, so an id it was never sent is skipped, not filled with a hole [#6588].
    next[field] = (ids ?? (state[field] ?? []).map((entry) => entry[key])).map((id) => entries.get(id)).filter((entry) => entry !== undefined);
  }
  // The rolling pace travels once, not inside each milestone it did not otherwise change, so a moved pace reaches every milestone here.
  if (delta.milestonePace) next.milestones = (next.milestones ?? []).map((milestone) => milestone?.summary ? { ...milestone, summary: { ...milestone.summary, pace: delta.milestonePace } } : milestone);
  return next;
}

/** Choose the same HTTP refusal class for local and sealed relay adapters. */
export function apiStatus(error) {
  if (error instanceof Refused && error.code === 'ACCOUNT_STORAGE_LIMIT') return 507;
  return { RELAY_BOARD_DELETED: 410, AUTH_REQUIRED: 401, DEVICE_REVOKED: 403, TOKEN_BOARD: 403, API_ORIGIN: 403, BAD_ORIGIN: 403, WRITE_REQUIRED: 403, HUMAN_REQUIRED: 403, NO_REPO_ACCESS: 403, NO_BOARD: 404, NO_SHOUT: 404, BOARD_NOT_LINKED: 404, NO_SNAPSHOT: 404, BASELINE_EXISTS: 412, SNAPSHOT_REQUIRED: 409, SEQUENCE_REPEAT: 409, SEQUENCE_GAP: 409, API_BUSY: 503, API_WORKER_FAILED: 503, API_CALL_TIMEOUT: 503, API_CLOSED: 503 }[error.code] ?? (error instanceof Refused ? 400 : 500);
}

// Relay-only snapshot/delete routes reuse the exact shared bounded-body and refusal boundary.
/** The relay service renders its own refusals: the caller supplies the renderer, as every other caller does. */
export function apiRefusal(error, refusalDocument) { return refusalFor(refusalDocument, error); }
export { json as apiJson, readBody as readApiBody };
