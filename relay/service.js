/** Opt-in sealed API v1 relay: authorization, opaque persistence and ordered live delivery [A4,H7,H16,H3]. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApiHandler, apiJson, apiRefusal, apiStatus, readApiBody } from '../src/api-http.js';
import { Refused } from '../src/refused.js';
import { createRelayJournal } from './journal.js';
import { createRelayRetention } from './retention.js';
import { createDeviceStore } from './device-store.js';
import { createDeviceHandler } from './device-http.js';
import { createPairingStore } from './pairing-store.js';
import { createPairingHandler } from './pairing-http.js';
import { createKeyRequestStore } from './key-request-store.js';
import { createKeyRequestHandler } from './key-request-http.js';
import { createRelayBrowserHandler } from './browser-page.js';
import { VERIFIER_STANDING_ENGINE } from '../src/machine.js';
import { SEALED_SNAPSHOT_BYTES, SNAPSHOT_BODY_BYTES } from '../src/relay-limits.js';
import { createRelayPagesHandler, snapshotPageRoot } from './pages-http.js';
import { createStorageQuota } from './storage-quota.js';
import { createUploadStatusHandler } from './upload-status.js';
import { createRelayBoardLinks } from './board-links.js';

const SNAPSHOT_BODY = SNAPSHOT_BODY_BYTES;
const STORED_BYTES = SEALED_SNAPSHOT_BYTES;

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
    const match = /^Bearer ((?:ps_|pa_|pm_)[A-Za-z0-9_-]{43})$/.exec(String(authorization));
    if (!match) throw new Refused('AUTH_REQUIRED', 'supply a current relay bearer credential');
    return match[1];
  }
  const cookies = String(req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('pb_session='));
  if (cookies.length !== 1 || !publicOrigin) throw new Refused('AUTH_REQUIRED', 'sign in to the configured relay origin');
  if (write && req.headers.origin !== publicOrigin) throw new Refused('BAD_ORIGIN', 'send cookie-authorized writes from the configured relay origin');
  const session = cookies[0].slice('pb_session='.length);
  if (!/^ps_[A-Za-z0-9_-]{43}$/.test(session)) throw new Refused('AUTH_REQUIRED', 'sign in to the relay in this browser');
  return session;
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
function sealed(body, allowRegistration = false) {
  const keys = allowRegistration ? ['sealed', 'sequence', 'registration'] : ['sealed', 'sequence'];
  if (!body || Object.keys(body).some((key) => !keys.includes(key)) || typeof body.sealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.sealed)) {
    throw new Refused('BAD_UPLOAD', 'send only sequence and a nonempty base64url sealed payload; keep keys on your device');
  }
  const bytes = Buffer.from(body.sealed, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== body.sealed) throw new Refused('BAD_UPLOAD', 'send canonical nonempty base64url bytes sealed on your device');
  return bytes;
}

/** Give live events the common API cursor while keeping all board contents sealed. */
function event(row) {
  return { event_id: row.sequence, event_at: row.receivedAt, kind: row.kind, sender: row.sender,
    ...(row.registration ? { registration: row.registration } : {}), sealed: row.bytes.toString('base64url') };
}

/**
 * Check a seat receipt against what the relay itself knows (#579): the sending agent token is the
 * creator, the target is another, non-coordinator seat, and sequence and digest name this exact
 * upload. The relay never reads the sealed move; replicas bind the target to its contents.
 */
function seatReceipt(body, who) {
  const value = body.registration;
  const fields = ['creator', 'digest', 'sequence', 'target'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== fields.join()) {
    throw new Refused('BAD_REGISTRATION', 'send a seat receipt with exactly target, creator, sequence and digest');
  }
  const name = /^[A-Za-z0-9_.-]{1,128}$/;
  if (who.kind !== 'board' || value.creator !== who.agent) throw new Refused('REGISTRATION_SENDER', 'register a seat with the creating seat\'s own token');
  if (typeof value.target !== 'string' || !name.test(value.target) || ['.', '..', 'coordinator', who.agent].includes(value.target)) {
    throw new Refused('BAD_REGISTRATION', 'name a new seat other than the creator and the coordinator');
  }
  if (value.sequence !== body.sequence || value.digest !== createHash('sha256').update(body.sealed).digest('hex')) {
    throw new Refused('BAD_REGISTRATION', 'the seat receipt must name this upload\'s sequence and the SHA-256 of its sealed text');
  }
  if (value.creator === 'coordinator' && who.root !== true) {
    throw new Refused('REGISTRATION_ROOT', 'only the coordinator credential the person set up creates seats; run pullboard relay on in the main checkout once');
  }
  return { target: value.target, creator: value.creator, sequence: value.sequence, digest: value.digest };
}

/** Give a snapshot its coverage cursor; clients unseal it and replay the following sealed events. */
function state(row) { return { sequence: row.sequence, receivedAt: row.receivedAt, sender: row.sender, sealed: row.bytes.toString('base64url') }; }

/**
 * Project a freshly authenticated credential to public sender metadata, never taking body fields. Every record names
 * the GitHub login behind it [E3]; on a board that names approvers, a person's record also says whether they are one,
 * and only an approver unlinks the board or replaces its snapshot [E4,E20].
 */
function sender(who, personOnly = false) {
  if (personOnly && who.kind !== 'session' && !(personOnly === 'snapshot' && who.kind === 'machine')) throw new Refused('HUMAN_REQUIRED', 'approve this person action from the paired phone');
  if (personOnly && who.approver === false) throw new Refused('NOT_APPROVER', `${who.user.login} is not an approver of this board; only an approver unlinks it or replaces its snapshot`);
  return { kind: who.kind === 'session' ? 'person' : who.kind === 'machine' ? 'machine' : 'agent', userId: who.user.id,
    ...(typeof who.user.login === 'string' ? { login: who.user.login } : {}), ...(who.kind === 'session' && typeof who.approver === 'boolean' ? { approver: who.approver } : {}),
    // The engine the sender declared: a seal no replica opens, from an engine no newer than the replica's, is junk to set aside [E20].
    ...(Number.isSafeInteger(who.engineVersion) && who.engineVersion > 0 ? { engine: who.engineVersion } : {}),
    ...(who.kind === 'board' ? { agent: who.agent } : who.kind === 'machine' ? { machine: who.machine } : {}),
    ...(personOnly === 'snapshot' ? {} : { policy: VERIFIER_STANDING_ENGINE,
      ...(who.root === true ? { root: true, ...(who.lineage ? { lineage: who.lineage } : {}) } : {}) }) };
}

/** Create a private relay handler; the caller owns sign-in lifecycle and service shutdown. */
export function createRelayHandler({ directory, auth, pollMs = 200, publicOrigin, now = Date.now, backupsDirectory, maintenanceMs = 60_000, accountStorageBytes, boardLinkAuthority }) {
  const origin = trustedOrigin(publicOrigin);
  if (typeof directory !== 'string' || !directory.trim() || !auth) throw new Refused('RELAY_CONFIG', 'configure a private relay directory and sign-in component');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Refused('RELAY_STORAGE', 'use a private directory with mode 700 for relay storage');
  // Older custom auth adapters remain explicitly API1-only, never an unmetered API2 transport.
  const quota = auth.storageAccount && auth.storageBoards ? createStorageQuota({ directory: root, auth, limitBytes: accountStorageBytes }) : null;

  if (!Number.isSafeInteger(maintenanceMs) || maintenanceMs < 0 || maintenanceMs > 2_147_483_647 || (maintenanceMs > 0 && maintenanceMs < 10)) {
    throw new Refused('RELAY_CONFIG', 'use a maintenance interval of at least ten milliseconds, or zero for an external scheduler');
  }
  const retention = createRelayRetention({ directory: root, backupsDirectory, auth, now, onDelete: id => quota?.clear(id) });
  let maintenanceError = null;

  /** Expose only a stable failure code to the trusted operator; never log paths, keys or provider errors. */
  function maintain() {
    try {
      const result = retention.maintain();
      if (quota) for (const link of auth.linkedBoards()) collectPages(link.id);
      maintenanceError = null; return result;
    }
    catch (error) { maintenanceError = error instanceof Refused ? error.code : 'RELAY_MAINTENANCE'; throw error; }
  }
  const timer = maintenanceMs ? setInterval(() => { try { maintain(); } catch { /* operator reads maintenanceStatus */ } }, maintenanceMs) : null;
  timer?.unref();

  /** Check expiry only after normal authorization; the first authorized contact also purges overdue data. */
  async function authorized(token, id, write = false) {
    const who = deviceStore.authorizeSession(await auth.authenticate(token, { board: identity(id), write }));
    if (retention.expire(id)) throw new Refused('NO_BOARD', 'this inactive link expired; link and upload the local board again');
    // Whether this person is one of the board's approvers, or undefined for a board that names none [E4].
    const approver = auth.isApprover?.(identity(id), who);
    return typeof approver === 'boolean' ? { ...who, approver } : who;
  }

  const deviceStore = createDeviceStore({ directory: root, now });
  // Auth handlers share this same auth object, so revoked sessions cannot mint a new reader elsewhere.
  const releaseSessionGuard = auth.addSessionGuard?.(principal => deviceStore.authorizeSession(principal));
  const deviceHandler = createDeviceHandler({
    authenticate: async (req, write) => deviceStore.authorizeSession(await auth.authenticate(credential(req, origin, write))),
    authorizeBoard: (req, id) => authorizedRequest(req, id, true),
    boardsFor: req => auth.boardsFor(credential(req, origin)),
    devices: deviceStore,
    linkBoard: (req, id, repository) => auth.linkBoard(credential(req, origin, true), id, repository),
    issueMachine: (req, value) => auth.issueMachine(credential(req, origin, true), value),
    issueActionGrant: (req, context) => auth.issueActionGrant(credential(req, origin, true), context),
    consumeActionGrant: (req, grant, context) => auth.consumeActionGrant(credential(req, origin, true), grant, context),
    revokeToken: (principal, id, board) => auth.revokeApprovedToken(principal, id, board),
    deleteBoard: async (req, id) => {
      const who = await authorizedRequest(req, id, true);
      sender(who, true);
      auth.withBoard(id, () => { requireClientVersion(id, who.engineVersion); retention.unlink(id); deviceStore.unlink(id); });
    },
  });
  const pairingStore = createPairingStore({ now });
  const pairing = createPairingHandler({
    authenticate: (req, { board, write }) => authorizedRequest(req, board, write),
    pairings: pairingStore,
  });
  const keyRequestStore = createKeyRequestStore({ now });
  const keyRequests = createKeyRequestHandler({ authenticate: (req, id, write) => authorizedRequest(req, id, write), requests: keyRequestStore });
  /** Refuse an old or ambiguous client before the opaque journal can return or accept board records. */
  async function authorizedRequest(req, id, write = false) {
    const who = await authorized(credential(req, origin, write), id, write);
    const declared = req.headers['x-pullboard-engine'];
    const version = declared === undefined ? 1 : typeof declared === 'string' && /^[1-9][0-9]*$/.test(declared) ? Number(declared) : NaN;
    requireClientVersion(id, version);
    if (write && quota) auth.storageAccount(id, who.user.id);
    return { ...who, engineVersion: version };
  }

  /** Recheck the minimum under the board lock so issuing a token cannot race a record read or write. */
  function requireClientVersion(id, version) {
    const minimum = auth.minimumEngineVersion(id);
    if (!Number.isSafeInteger(version) || version < minimum) {
      throw new Refused('ENGINE_VERSION', `this board requires engine version ${minimum} or newer; upgrade pullboard before reading or sending relay records`);
    }
  }

  /** Add an authorized next-contact warning without exposing any plaintext board contents. */
  function annotated(row, id) {
    if (row.apiVersion === 2) throw new Refused('RELAY_API_VERSION', 'This board requires relay API version 2. Upgrade with npm i -g pullboard@latest.');
    const warning = quota?.notice(id) ?? retention.notice(id);
    return { ...state(row), ...(warning ? { warning } : {}) };
  }

  /** Keep the budget check and its write inside the same authenticated lifecycle transaction. */
  function storing(id, principal, delta, write) { return quota ? quota.change(id, principal, delta, write) : write(); }

  /** Open only an existing journal on reads; each synchronous operation closes its connection. */
  function withJournal(id, work, create = false, engineVersion) {
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
      requireClientVersion(id, engineVersion);
      const journal = createRelayJournal({ directory: root, boardId: id, maxBytes: STORED_BYTES, now: () => new Date(now()) });
      try { return work(journal); } finally { journal.close(); }
    });
  }

  /** Collect expired staging and read pins without opening a missing board or decoding its opaque bytes. */
  function collectPages(id) {
    try { lstatSync(join(root, identity(id) + '.journal.sqlite')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    auth.withBoard(id, () => {
      const journal = createRelayJournal({ directory: root, boardId: id, maxBytes: STORED_BYTES, now: () => new Date(now()) });
      const pages = journal.pages({ now });
      try { const current = snapshotPageRoot(journal.snapshot()); pages.prune(current ? [current.id] : []); }
      finally { pages.close(); journal.close(); }
    });
  }

  /** Probe only account totals after expired staging is reclaimed, never a full snapshot or a device-supplied account. */
  function refreshStorage(id, principal) {
    return auth.withBoard(id, () => {
      const account = auth.storageAccount(id, principal.userId);
      if (account) for (const board of auth.storageBoards(account.id)) collectPages(board);
      const storage = quota.usage(id, principal), warning = quota.notice(id);
      return { storage, ...(warning ? { warning } : {}) };
    });
  }

  /**
   * Let token issuance see a published seat receipt under the same board lock that appends it, so
   * a receipt claims its target before, and whether or not, its enrollment finishes (#579). An
   * auth stub without token issuance (some fixtures) has nothing to wire.
   */
  auth.setRegistrationClaims?.((id, target) => {
    const file = join(root, identity(id) + '.journal.sqlite');
    try { if (!lstatSync(file).isFile()) return null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return auth.withBoard(id, () => {
      const journal = createRelayJournal({ directory: root, boardId: id, maxBytes: STORED_BYTES, now: () => new Date(now()) });
      try { return journal.registrationFor(target); } finally { journal.close(); }
    });
  });

  /** Append ciphertext under its server-allocated sequence, with no engine or filesystem access. */
  async function append(board, body, who, kind = 'move') {
    const bytes = sealed(body, kind === 'move');
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new Refused('BAD_SEQUENCE', 'seal this move for the next positive sequence after the latest committed prefix');
    const authenticated = await authorized(who.credential, board.id, true);
    const principal = sender({ ...authenticated, engineVersion: who.engineVersion });
    if (body.registration === undefined) {
      return withJournal(board.id, (journal) => {
        const row = body.sequence <= journal.latest() ? journal.append(body.sequence, bytes, kind, principal)
          : storing(board.id, principal, bytes.byteLength, () => journal.append(body.sequence, bytes, kind, principal));
        return { status: 200, body: { event: event(row), result: { sequence: row.sequence } } };
      }, false, who.engineVersion);
    }
    // A registration move and its target's first token commit under one board lock; the token
    // goes only to this authenticated creator, never into the public event (#579).
    const receipt = seatReceipt(body, authenticated);
    return withJournal(board.id, (journal) => {
      const prior = auth.seatRecord(board.id, receipt.target);
      const retry = prior && prior.origin === 'registered' && prior.creator === receipt.creator && prior.sequence === receipt.sequence && prior.digest === receipt.digest;
      if (prior && !retry) throw new Refused('SEAT_TAKEN', `the relay already issued ${receipt.target} a token, so it cannot be registered again; register the next free name`);
      let row;
      try { row = retry ? journal.recordAt(receipt.sequence) : body.sequence <= journal.latest()
        ? journal.append(body.sequence, bytes, kind, principal, receipt)
        : storing(board.id, principal, bytes.byteLength, () => journal.append(body.sequence, bytes, kind, principal, receipt)); }
      catch (error) {
        // The move and its receipt committed but the seat did not (any failure before enrollment):
        // the creator's exact retry rolls the enrollment forward, even after compaction.
        if (!['SEQUENCE_REPEAT', 'SEAT_TAKEN'].includes(error.code) || JSON.stringify(journal.registrationFor(receipt.target)) !== JSON.stringify(receipt)) throw error;
        row = journal.recordAt(receipt.sequence);
        if (row && !row.bytes.equals(bytes)) throw error;
      }
      const enrollment = auth.enrollSeat(who.credential, board.id, receipt);
      const committed = row ? event(row) : { event_id: receipt.sequence, kind, sender: principal, registration: receipt, sealed: body.sealed };
      return { status: 200, body: { event: committed, result: { sequence: receipt.sequence }, enrollment } };
    }, false, who.engineVersion);
  }

  const browser = origin ? createRelayBrowserHandler({ authenticate: (req) => auth.authenticate(credential(req, origin)) }) : null;
  const pagesHandler = createRelayPagesHandler({ directory: root, now, authorize: authorizedRequest, withJournal, sender, quota, annotated, refreshStorage, enabled: Boolean(quota) });
  const common = createApiHandler({
    authenticate: async (req, { board, write }) => {
      const token = credential(req, origin, write);
      if (board !== null) return { ...await authorizedRequest(req, board, write), credential: token };
      if (token.startsWith('ps_')) deviceStore.authorizeSession(await auth.authenticate(token));
      const visible = await auth.boardsFor(token);
      if (token.startsWith('ps_')) deviceStore.authorizeSession(await auth.authenticate(token));
      return { visible };
    },
    boards: (who) => {
      const boards = who.visible.filter((board) => !retention.expire(board.id));
      const warnedAccounts = new Set();
      const warnings = boards.flatMap((board) => {
        const storage = quota?.notice(board.id);
        const accountId = storage?.storage?.account?.id;
        if (accountId && warnedAccounts.has(accountId)) return [retention.notice(board.id)].filter(Boolean);
        if (accountId) warnedAccounts.add(accountId);
        return [retention.notice(board.id), ...(storage ? [{ board: board.id, ...storage }] : [])].filter(Boolean);
      });
      return { boards, ...(warnings.length ? { warnings } : {}) };
    },
    board: (id, who) => { withJournal(id, () => undefined, false, who.engineVersion); return { id, engineVersion: who.engineVersion }; },
    state: (board) => withJournal(board.id, (journal) => {
      const snapshot = journal.snapshot();
      if (!snapshot) throw new Refused('NO_SNAPSHOT', 'upload a sealed snapshot before reading this board');
      return annotated(snapshot, board.id);
    }, false, board.engineVersion),
    events: (board, after) => withJournal(board.id, (journal) => {
      const snapshot = journal.snapshot();
      if (snapshot && after < snapshot.sequence) throw new Refused('SNAPSHOT_REQUIRED', 'fetch the latest sealed state, then resume after its sequence');
      return journal.after(after).map(event);
    }, false, board.engineVersion),
    warning: (board) => retention.notice(board.id),
    // A waiting key request rides on the member's ordinary event read, so handing a key over costs no extra call [E17].
    warnings: (board) => [quota?.notice(board.id), keyRequestStore.count(board.id) ? { code: 'KEY_REQUESTS', count: keyRequestStore.count(board.id) } : null].filter(Boolean),
    move: append,
    request: async (board, body, who) => (await append(board, body, who, 'request')).body,
  }, { pollMs });

  const uploadStatus = createUploadStatusHandler({ authorize: authorizedRequest, withJournal, sender });
  let boardLinks = null;
  try {
    if (boardLinkAuthority) boardLinks = createRelayBoardLinks({ directory: root, authority: boardLinkAuthority,
      authorize: authorizedRequest, auth, withJournal, store: storing, now });
  } catch (error) {
    clearInterval(timer); common.close(); releaseSessionGuard?.(); deviceStore.close(); quota?.close();
    throw error;
  }

  /** Add authenticated snapshot replacement and deletion to the common versioned read/move paths. */
  async function handle(req, res) {
    if (await pagesHandler(req, res)) return;
    if (await deviceHandler(req, res)) return;
    if (await pairing(req, res)) return;
    if (await keyRequests(req, res)) return;
    try {
      if (browser && await browser(req, res)) return;
      let url;
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
      catch { throw new Refused('BAD_REQUEST', 'use a valid path under /api/v1/boards'); }
      if (/^\/api\/v1\/boards\/[^/]+\/(links(?:\/[^/]+)?|link-deliveries)$/u.test(url.pathname)) {
        if (!boardLinks) throw new Refused('BOARD_LINK_AUTH', 'configure the trusted board signer-authority port before linking boards');
        if (await boardLinks.handle(req, res, url)) return;
      }
      if (await uploadStatus(req, res, url)) return;
      const approvers = /^\/api\/v1\/boards\/([^/]+)\/approvers$/.exec(url.pathname);
      if (approvers && req.method === 'GET') {
        const id = identity(approvers[1]);
        await authorizedRequest(req, id);
        return apiJson(res, 200, { board: id, approvers: auth.boardApprovers(id) });
      }
      if (approvers && req.method === 'PUT') {
        const id = identity(approvers[1]);
        const body = await readApiBody(req, { maxBytes: 8_192 });
        return apiJson(res, 200, await auth.setBoardApprovers(credential(req, origin, true), id, body.approvers));
      }
      const snapshot = /^\/api\/v1\/boards\/([^/]+)\/state$/.exec(url.pathname);
      const deletion = /^\/api\/v1\/boards\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && snapshot) {
        const id = identity(snapshot[1]);
        const who = await authorizedRequest(req, id);
        const saved = withJournal(id, journal => {
          const row = journal.snapshot();
          if (!row) throw new Refused('NO_SNAPSHOT', 'upload a sealed snapshot before reading this board');
          return annotated(row, id);
        }, false, who.engineVersion);
        const tag = '"' + createHash('sha256').update(JSON.stringify(saved)).digest('hex') + '"';
        res.setHeader('etag', tag);
        if (req.headers['if-none-match'] === tag) {
          res.writeHead(304, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
          return res.end();
        }
        return apiJson(res, 200, { state: saved });
      }
      if (req.method === 'PUT' && snapshot) {
        const id = identity(snapshot[1]);
        sender(await authorizedRequest(req, id, true), 'snapshot');
        const body = await readApiBody(req, { maxBytes: SNAPSHOT_BODY });
        const bytes = sealed(body);
        if (!Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new Refused('BAD_SEQUENCE', 'name the nonnegative sequence covered by the sealed snapshot');
        const who = await authorizedRequest(req, id, true);
        const principal = sender(who, 'snapshot');
        const saved = withJournal(id, (journal) => {
          if (journal.snapshot()?.apiVersion === 2) throw new Refused('RELAY_API_VERSION', 'This board requires relay API version 2. Upgrade with npm i -g pullboard@latest.');
          const row = storing(id, principal, journal.snapshotDelta(body.sequence, bytes), () => journal.saveSnapshot(body.sequence, bytes, principal, { initialOnly: req.headers['if-none-match'] === '*' }));
          quota?.clear(id);
          return row;
        }, true, who.engineVersion);
        return apiJson(res, 200, { state: annotated(saved, id) });
      }
      if (req.method === 'DELETE' && deletion) {
        const id = identity(deletion[1]);
        const who = await authorizedRequest(req, id, true);
        sender(who, true);
        auth.withBoard(id, () => { requireClientVersion(id, who.engineVersion); retention.unlink(id); deviceStore.unlink(id); });
        return apiJson(res, 200, { deleted: id });
      }
      return await common(req, res);
    } catch (error) {
      if (!res.headersSent) {
        const document = apiRefusal(error);
        const size = error.snapshotLimit;
        if (error.code === 'BAD_UPLOAD' && Number.isSafeInteger(size?.sealedBytes) && Number.isSafeInteger(size?.limit)
            && size.limit > 0 && size.sealedBytes > size.limit) {
          document.error.snapshotLimit = { sealedBytes: size.sealedBytes, limit: size.limit };
        }
        apiJson(res, apiStatus(error), document);
      }
      else res.end();
    }
  }
  handle.maintenance = maintain;
  handle.backup = retention.backup;
  handle.maintenanceStatus = () => ({ error: maintenanceError });
  handle.close = () => { clearInterval(timer); common.close(); releaseSessionGuard?.(); deviceStore.close(); quota?.close(); boardLinks?.close(); };
  return handle;
}

/** Start the opt-in service on a configured address; tests use loopback and an ephemeral port. */
export function serveRelay({ directory, auth, port = 0, host = '127.0.0.1', pollMs = 200, publicOrigin, now, backupsDirectory, maintenanceMs, accountStorageBytes, boardLinkAuthority }) {
  const handler = createRelayHandler({ directory, auth, pollMs, publicOrigin, now, backupsDirectory, maintenanceMs, accountStorageBytes, boardLinkAuthority });
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
