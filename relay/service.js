/** Opt-in sealed API v1 relay: authorization, opaque persistence and ordered live delivery [A4,H7]. */
import { createServer } from 'node:http';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApiHandler, apiJson, apiRefusal, apiStatus, readApiBody } from '../src/api-http.js';
import { Refused } from '../src/refused.js';
import { createRelayJournal } from './journal.js';
import { createRelayRetention } from './retention.js';

const SNAPSHOT_BODY = 14_000_000;
const STORED_BYTES = 10_000_000;

/** Validate a board identity before deriving its private, internal database path. */
function identity(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new Refused('BAD_BOARD', 'use the persistent board id, never a path');
  return id;
}

/**
 * Resolve the existing relay session cookie or bearer boundary. Cookie writes require a configured
 * exact public Origin; duplicate cookies, URL credentials and client-controlled hosts never win.
 */
function credential(req, publicOrigin, write = false) {
  const authorization = req.headers.authorization;
  if (authorization) {
    const match = /^Bearer ((?:ps_|pa_)[A-Za-z0-9_-]{43})$/.exec(String(authorization));
    if (!match) throw new Refused('AUTH_REQUIRED', 'supply a current relay bearer credential');
    return match[1];
  }
  const cookies = String(req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('pb_session='));
  if (cookies.length !== 1 || !publicOrigin) throw new Refused('AUTH_REQUIRED', 'sign in to the configured relay origin');
  if (write && req.headers.origin !== publicOrigin) throw new Refused('BAD_ORIGIN', 'send cookie-authorized writes from the configured relay origin');
  return cookies[0].slice('pb_session='.length);
}

/** Validate an optional trusted browser origin, never inferring one from a request header. */
function trustedOrigin(value) {
  if (value === undefined) return null;
  let url;
  try { url = new URL(value); } catch { throw new Refused('RELAY_CONFIG', 'configure the relay public origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Refused('RELAY_CONFIG', 'use an HTTPS public origin or a loopback HTTP origin for local tests');
  }
  return url.origin;
}

/** Decode only canonical transport bytes; sealed payloads are never parsed or unsealed. */
function sealed(body) {
  const keys = ['sealed', 'sequence'];
  if (!body || Object.keys(body).some((key) => !keys.includes(key)) || typeof body.sealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.sealed)) {
    throw new Refused('BAD_UPLOAD', 'send only sequence and a nonempty base64url sealed payload; keep keys on your device');
  }
  const bytes = Buffer.from(body.sealed, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== body.sealed) throw new Refused('BAD_UPLOAD', 'send canonical nonempty base64url bytes sealed on your device');
  return bytes;
}

/** Give live events the common API cursor while keeping all board contents sealed. */
function event(row) { return { event_id: row.sequence, event_at: row.receivedAt, kind: row.kind, sender: row.sender, sealed: row.bytes.toString('base64url') }; }

/** Give a snapshot its coverage cursor; clients unseal it and replay the following sealed events. */
function state(row) { return { sequence: row.sequence, receivedAt: row.receivedAt, sender: row.sender, sealed: row.bytes.toString('base64url') }; }

/** Project a freshly authenticated credential to public sender metadata, never taking body fields. */
function sender(who, personOnly = false) {
  if (personOnly && who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'sign in as a person to replace a snapshot or unlink a board');
  return { kind: who.kind === 'session' ? 'person' : 'agent', userId: who.user.id,
    ...(who.kind === 'board' ? { agent: who.agent } : {}) };
}

/** Create a private relay handler; the caller owns sign-in lifecycle and service shutdown. */
export function createRelayHandler({ directory, auth, pollMs = 200, publicOrigin, now = Date.now, backupsDirectory, maintenanceMs = 60_000 }) {
  const origin = trustedOrigin(publicOrigin);
  if (typeof directory !== 'string' || !directory.trim() || !auth) throw new Refused('RELAY_CONFIG', 'configure a private relay directory and sign-in component');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Refused('RELAY_STORAGE', 'use a private directory with mode 700 for relay storage');

  if (!Number.isSafeInteger(maintenanceMs) || maintenanceMs < 0 || maintenanceMs > 2_147_483_647 || (maintenanceMs > 0 && maintenanceMs < 10)) {
    throw new Refused('RELAY_CONFIG', 'use a maintenance interval of at least ten milliseconds, or zero for an external scheduler');
  }
  const retention = createRelayRetention({ directory: root, backupsDirectory, auth, now });
  let maintenanceError = null;

  /** Expose only a stable failure code to the trusted operator; never log paths, keys or provider errors. */
  function maintain() {
    try { const result = retention.maintain(); maintenanceError = null; return result; }
    catch (error) { maintenanceError = error instanceof Refused ? error.code : 'RELAY_MAINTENANCE'; throw error; }
  }
  const timer = maintenanceMs ? setInterval(() => { try { maintain(); } catch { /* operator reads maintenanceStatus */ } }, maintenanceMs) : null;
  timer?.unref();

  /** Check expiry only after normal authorization; the first authorized contact also purges overdue data. */
  async function authorized(token, id, write = false) {
    const who = await auth.authenticate(token, { board: identity(id), write });
    if (retention.expire(id)) throw new Refused('NO_BOARD', 'this inactive link expired; link and upload the local board again');
    return who;
  }

  /** Add an authorized next-contact warning without exposing any plaintext board contents. */
  function annotated(row, id) {
    const warning = retention.notice(id);
    return { ...state(row), ...(warning ? { warning } : {}) };
  }

  /** Open only an existing journal on reads; each synchronous operation closes its connection. */
  function withJournal(id, work, create = false) {
    const file = join(root, identity(id) + '.journal.sqlite');
    if (!create) {
      try {
        const entry = lstatSync(file);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Refused('RELAY_STORAGE', 'restore this board as a private regular journal');
      } catch (error) {
        if (error.code === 'ENOENT') throw new Refused('NO_BOARD', 'upload the sealed snapshot for this linked board first');
        throw error;
      }
    }
    return auth.withBoard(id, () => {
      const journal = createRelayJournal({ directory: root, boardId: id, maxBytes: STORED_BYTES, now: () => new Date(now()) });
      try { return work(journal); } finally { journal.close(); }
    });
  }

  /** Append ciphertext under its server-allocated sequence, with no engine or filesystem access. */
  async function append(board, body, who, kind = 'move') {
    const bytes = sealed(body);
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new Refused('BAD_SEQUENCE', 'seal this move for the next positive sequence after the latest committed prefix');
    const principal = sender(await authorized(who.credential, board.id, true));
    return withJournal(board.id, (journal) => {
      const row = journal.append(body.sequence, bytes, kind, principal);
      return { status: 200, body: { event: event(row), result: { sequence: row.sequence } } };
    });
  }

  const common = createApiHandler({
    authenticate: async (req, { board, write }) => {
      const token = credential(req, origin, write);
      return board === null ? { visible: await auth.boardsFor(token) }
        : { ...await authorized(token, board, write), credential: token };
    },
    boards: (who) => {
      const boards = who.visible.filter((board) => !retention.expire(board.id));
      const warnings = boards.map((board) => retention.notice(board.id)).filter(Boolean);
      return { boards, ...(warnings.length ? { warnings } : {}) };
    },
    board: (id) => { withJournal(id, () => undefined); return { id }; },
    state: (board) => withJournal(board.id, (journal) => {
      const snapshot = journal.snapshot();
      if (!snapshot) throw new Refused('NO_SNAPSHOT', 'upload a sealed snapshot before reading this board');
      return annotated(snapshot, board.id);
    }),
    events: (board, after) => withJournal(board.id, (journal) => {
      const snapshot = journal.snapshot();
      if (snapshot && after < snapshot.sequence) throw new Refused('SNAPSHOT_REQUIRED', 'fetch the latest sealed state, then resume after its sequence');
      return journal.after(after).map(event);
    }),
    warning: (board) => retention.notice(board.id),
    move: append,
    request: async (board, body, who) => (await append(board, body, who, 'request')).body,
  }, { pollMs });

  /** Add authenticated snapshot replacement and deletion to the common versioned read/move paths. */
  async function handle(req, res) {
    try {
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
      catch { throw new Refused('BAD_REQUEST', 'use a valid path under /api/v1/boards'); }
      const snapshot = /^\/api\/v1\/boards\/([^/]+)\/state$/.exec(url.pathname);
      const deletion = /^\/api\/v1\/boards\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'PUT' && snapshot) {
        const id = identity(snapshot[1]);
        sender(await authorized(credential(req, origin, true), id, true), true);
        const body = await readApiBody(req, { maxBytes: SNAPSHOT_BODY });
        const bytes = sealed(body);
        if (!Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new Refused('BAD_SEQUENCE', 'name the nonnegative sequence covered by the sealed snapshot');
        const principal = sender(await authorized(credential(req, origin, true), id, true), true);
        const saved = withJournal(id, (journal) => journal.saveSnapshot(body.sequence, bytes, principal), true);
        return apiJson(res, 200, { state: annotated(saved, id) });
      }
      if (req.method === 'DELETE' && deletion) {
        const id = identity(deletion[1]);
        sender(await authorized(credential(req, origin, true), id, true), true);
        retention.unlink(id);
        return apiJson(res, 200, { deleted: id });
      }
      return await common(req, res);
    } catch (error) {
      if (!res.headersSent) apiJson(res, apiStatus(error), apiRefusal(error));
      else res.end();
    }
  }
  handle.maintenance = maintain;
  handle.backup = retention.backup;
  handle.maintenanceStatus = () => ({ error: maintenanceError });
  handle.close = () => { clearInterval(timer); common.close(); };
  return handle;
}

/** Start the opt-in service on a configured address; tests use loopback and an ephemeral port. */
export function serveRelay({ directory, auth, port = 0, host = '127.0.0.1', pollMs = 200, publicOrigin, now, backupsDirectory, maintenanceMs }) {
  const handler = createRelayHandler({ directory, auth, pollMs, publicOrigin, now, backupsDirectory, maintenanceMs });
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  return new Promise((ready, fail) => {
    server.once('error', (error) => { handler.close(); fail(new Refused(error.code === 'EADDRINUSE' ? 'PORT_BUSY' : 'RELAY_LISTEN', 'cannot listen on the configured relay address; choose a free port and retry')); });
    server.listen(port, host, () => ready({
      port: server.address().port,
      maintenance: handler.maintenance,
      backup: handler.backup,
      maintenanceStatus: handler.maintenanceStatus,
      close: () => new Promise((done) => { handler.close(); server.close(done); server.closeAllConnections(); }),
    }));
  });
}
