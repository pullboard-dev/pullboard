/** Hash-only relay sessions and board credentials, authorized by current GitHub roles [H8, H1, H13, H14, H16, H3]. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../src/refused.js';
import { computerName } from '../src/computer-name.js';
import { repositoryName } from './github.js';
import { approvalContext } from '../src/relay-approval.js';
import { VERIFIER_STANDING_ENGINE } from '../src/machine.js';
import { PEOPLE_ENGINE } from '../src/people-engine.js';

export const ACCESS_WINDOW_MS = 10 * 60_000;
const MAX_TTL = 30 * 24 * 3600_000;

/** Hash credentials before any database lookup or persistence. */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Generate an unpredictable relay credential, distinct from GitHub credentials. */
function random(prefix) { return prefix + randomBytes(32).toString('base64url'); }

/** Require a bounded explicit identifier without reflecting its input in errors. */
function identifier(value, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value) || value === '.' || value === '..') throw new Refused(code, 'use an identifier of 1 to 128 letters, digits, dots, underscores or hyphens');
  return value;
}

/** Compare two hashes without a variable-time comparison of a browser flow binding. */
function sameHash(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/**
 * Persist only relay credential hashes and account/repository identities. User OAuth credentials
 * live solely in the sign-in call; App credentials belong to the injected provider's RAM cache.
 */
export function createRelayAuth({ database, github, now = Date.now, sessionTTL = 7 * 24 * 3600_000, tokenTTL = 24 * 3600_000 }) {
  if (typeof database !== 'string' || !database || !github) throw new Refused('RELAY_CONFIG', 'configure an auth database and GitHub App provider');
  for (const ttl of [sessionTTL, tokenTTL]) if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL) throw new Refused('RELAY_CONFIG', 'set credential expiry between one millisecond and thirty days');
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  if (database !== ':memory:') chmodSync(database, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000; BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS relay_users (id TEXT PRIMARY KEY, login TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_boards (id TEXT PRIMARY KEY, repository TEXT NOT NULL, repository_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_cleanup (board TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS relay_board_off (board TEXT PRIMARY KEY, repository_id TEXT NOT NULL, replaced_by TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_deleted_credentials (hash TEXT PRIMARY KEY, board TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_credentials (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES relay_users(id), board TEXT REFERENCES relay_boards(id), agent TEXT, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relay_action_grants (hash TEXT PRIMARY KEY, request TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL, context TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relay_seats (board TEXT NOT NULL, agent TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('machine','registered','root')), creator TEXT, sequence INTEGER, digest TEXT,
        first_id TEXT, first_created INTEGER, first_expires INTEGER, PRIMARY KEY (board, agent));
      CREATE TABLE IF NOT EXISTS relay_coordinator_events (id TEXT PRIMARY KEY, board TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('bootstrap','reissue','reset')), session_id TEXT NOT NULL,
        revoked TEXT NOT NULL, issued_id TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    if (!db.prepare('PRAGMA table_info(relay_credentials)').all().some((column) => column.name === 'root')) {
      db.exec('ALTER TABLE relay_credentials ADD COLUMN root INTEGER NOT NULL DEFAULT 0');
    }
    // Which machine's person-set coordinator line a root token belongs to; renewals keep it (#579).
    if (!db.prepare('PRAGMA table_info(relay_credentials)').all().some((column) => column.name === 'lineage')) {
      db.exec('ALTER TABLE relay_credentials ADD COLUMN lineage TEXT');
    }
    // Every seat that already held a token got it from the machine or a person mint: machine origin for good (#579).
    db.exec(`INSERT OR IGNORE INTO relay_seats (board, agent, origin) SELECT DISTINCT board, agent, 'machine'
      FROM relay_credentials WHERE kind = 'board' AND board IS NOT NULL AND agent IS NOT NULL`);
    if (!db.prepare('PRAGMA table_info(relay_credentials)').all().some((column) => column.name === 'created')) {
      db.exec('ALTER TABLE relay_credentials ADD COLUMN created INTEGER');
    }
    // A joined computer's host name and last contact let its owner recognise it in relay devices.
    for (const column of ['host TEXT', 'seen INTEGER', 'name TEXT']) {
      if (!db.prepare('PRAGMA table_info(relay_credentials)').all().some((entry) => entry.name === column.split(' ')[0])) {
        db.exec('ALTER TABLE relay_credentials ADD COLUMN ' + column);
      }
    }
    // Older unshipped links receive a full retention grace period, rather than guessing their age.
    if (!db.prepare('PRAGMA table_info(relay_boards)').all().some((column) => column.name === 'linked_at')) {
      db.exec('ALTER TABLE relay_boards ADD COLUMN linked_at INTEGER');
    }
    if (!db.prepare('PRAGMA table_info(relay_boards)').all().some((column) => column.name === 'storage_account')) {
      db.exec('ALTER TABLE relay_boards ADD COLUMN storage_account TEXT REFERENCES relay_users(id)');
    }
    // A board's approvers (#343): GitHub logins as a JSON array, or NULL for a board that names none.
    if (!db.prepare('PRAGMA table_info(relay_boards)').all().some((column) => column.name === 'approvers')) {
      db.exec('ALTER TABLE relay_boards ADD COLUMN approvers TEXT');
    }
    db.prepare('UPDATE relay_boards SET linked_at=? WHERE linked_at IS NULL').run(now());
    db.prepare('DELETE FROM relay_deleted_credentials WHERE expires<=?').run(now());
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  const permissions = new Map();
  const webFlows = new Map();
  const deviceFlows = new Map();
  const deviceConfirmations = new Map();
  // A hashed ticket may revoke only its minted session, retained until that session expires.
  const deviceSessionReceipts = new Map();
  const sessionGuards = new Set();
  let closed = false;
  let locked = false;
  // The relay journal's published seat receipts, read under the board lock (#579); none until wired.
  let registrationClaim = () => null;

  /** Refuse operation after closing instead of surfacing a raw SQLite error. */
  function open() { if (closed) throw new Refused('RELAY_CLOSED', 'start the relay before signing in or using a credential'); }

  /** Serialize synchronous lifecycle work across relay processes sharing this auth database. */
  function lifecycle(work) {
    open();
    if (locked) return work();
    db.exec('BEGIN IMMEDIATE'); locked = true;
    try {
      const result = work();
      if (result && typeof result.then === 'function') throw new Refused('RELAY_CONFIG', 'finish synchronous lifecycle work before awaiting');
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { locked = false; }
  }

  /** Revoke a server-held device session when its person declined or abandoned confirmation. */
  function discardDeviceSession(flow) {
    if (!flow.session?.id) return;
    lifecycle(() => db.prepare('UPDATE relay_credentials SET revoked=1 WHERE id=? AND kind=?').run(flow.session.id, 'session'));
    flow.session = null;
  }

  /** Keep a confirmed device session retrievable only for its bounded CLI delivery window. */
  function deviceFlowExpiry(flow) { return flow.confirmed ? flow.deliveryExpires : flow.expires; }

  /** Resolve a current credential and latest account login without storing its plaintext. */
  function credential(token) {
    open();
    if (typeof token !== 'string' || !/^(ps_|pa_|pm_)[A-Za-z0-9_-]{43}$/.test(token)) throw new Refused('AUTH_REQUIRED', 'sign in to the relay or supply a current board token');
    db.prepare('DELETE FROM relay_deleted_credentials WHERE expires<=?').run(now());
    const digest = hash(token);
    const row = db.prepare('SELECT c.*, u.login FROM relay_credentials c JOIN relay_users u ON u.id=c.user_id WHERE c.hash=?').get(digest);
    const deleted = !row && db.prepare('SELECT board FROM relay_deleted_credentials WHERE hash=? AND expires>?').get(digest, now());
    if (deleted) throw new Refused('RELAY_BOARD_DELETED', `relay copy ${deleted.board} was deleted; keep working locally, or run pullboard relay on to link it again`);
    if (!row || row.revoked || row.expires <= now()) throw new Refused('AUTH_REQUIRED', 'this credential is expired or revoked; sign in or obtain a new board token');
    if (row.kind === 'session') {
      for (const guard of sessionGuards) guard({ id: row.id, kind: row.kind, user: { id: row.user_id }, expires: row.expires });
    }
    // Last seen moves at most once a minute, so ordinary sync does not rewrite the row on every request.
    if (row.kind === 'machine' && !(row.seen > now() - 60_000)) db.prepare('UPDATE relay_credentials SET seen=? WHERE id=?').run(now(), row.id);
    return row;
  }

  /** Mint one independently expiring/revocable credential and persist only its hash. */
  function issue(user, kind, board, agent, ttl, root = false, lineage = null) {
    open();
    const token = random(kind === 'session' ? 'ps_' : kind === 'machine' ? 'pm_' : 'pa_');
    const id = randomUUID();
    const created = now();
    const expires = created + ttl;
    db.prepare('INSERT INTO relay_credentials (id,hash,kind,user_id,board,agent,created,expires,root,lineage) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, hash(token), kind, user.id, board ?? null, agent ?? null, created, expires, root ? 1 : 0, root ? lineage : null);
    return { token, id, created, expires };
  }

  /** The first-mint record of one seat on one board, which outlives every credential it names. */
  function seat(board, agent) {
    return db.prepare('SELECT * FROM relay_seats WHERE board=? AND agent=?').get(board, agent) ?? null;
  }

  /** Record a seat's first issuance; the seat row exists before its token is ever returned. */
  function firstMint(user, board, agent, ttl, { origin, creator = null, sequence = null, digest = null, root = false, lineage = null }) {
    const issued = issue(user, 'board', board, agent, ttl, root, lineage);
    db.prepare(`INSERT INTO relay_seats (board,agent,origin,creator,sequence,digest,first_id,first_created,first_expires) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(board, agent) DO UPDATE SET origin=excluded.origin, creator=excluded.creator, sequence=excluded.sequence, digest=excluded.digest,
        first_id=excluded.first_id, first_created=excluded.first_created, first_expires=excluded.first_expires`)
      .run(board, agent, origin, creator, sequence, digest, issued.id, issued.created, issued.expires);
    return { ...issued, board, agent };
  }

  /** Validate an expiry request against the relay's thirty-day ceiling. */
  function expiry(value, what) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TTL) throw new Refused('BAD_EXPIRY', `choose a ${what} expiry between one millisecond and thirty days`);
    return value;
  }

  /** Learn the immutable GitHub identity, then drop the user access credential immediately. */
  async function signedIn(result, { cancelled } = {}) {
    if (!result || result.pending) throw new Refused('OAUTH_STATE', 'complete GitHub sign-in before creating a relay session');
    const user = await github.user(result.accessToken);
    if (cancelled?.()) throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
    open();
    if (!user || !/^[1-9][0-9]*$/.test(String(user.id)) || typeof user.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(user.login)) throw new Refused('GITHUB_AUTH', 'GitHub did not confirm your account; sign in again');
    db.prepare('INSERT INTO relay_users (id,login) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login').run(String(user.id), user.login);
    return { ...issue({ id: String(user.id) }, 'session', null, null, sessionTTL), user: { id: String(user.id), login: user.login } };
  }

  /** Remove expired in-memory flow secrets and limit anonymous sign-in allocations. */
  function pruneFlows() {
    open();
    for (const [key, flow] of deviceFlows) if (deviceFlowExpiry(flow) <= now() && !flow.busy) {
      if (!flow.confirmed) discardDeviceSession(flow);
      deviceFlows.delete(key);
      if (flow.confirmationTicket) deviceConfirmations.delete(hash(flow.confirmationTicket));
    }
    for (const map of [webFlows, deviceConfirmations]) for (const [key, flow] of map) if (flow.expires <= now()) map.delete(key);
    for (const [key, receipt] of deviceSessionReceipts) if (receipt.expires <= now()) deviceSessionReceipts.delete(key);
    const activeTickets = new Set([...deviceFlows.keys(), ...deviceSessionReceipts.keys()]);
    if (new Set([...webFlows.keys(), ...activeTickets]).size >= 10_000) throw new Refused('SIGN_IN_BUSY', 'too many sign-ins are pending; retry shortly');
  }

  /** Look up a live pending browser confirmation without accepting the CLI polling ticket. */
  function confirmation(ticket) {
    open();
    if (typeof ticket !== 'string') throw new Refused('OAUTH_EXPIRED', 'the relay confirmation expired; run pullboard relay on again');
    const key = hash(ticket);
    const flow = deviceConfirmations.get(key);
    if (!flow || flow.cancelled || flow.expires <= now()) {
      deviceConfirmations.delete(key);
      if (flow) {
        if (!flow.confirmed) {
          deviceFlows.delete(flow.deviceTicketHash);
          discardDeviceSession(flow);
        }
      }
      throw new Refused('OAUTH_EXPIRED', 'the relay confirmation expired; run pullboard relay on again');
    }
    return { key, flow };
  }

  /** Validate the browser-only cookie binding before reading or changing a pending confirmation. */
  function confirmationBinding(flow, binding) {
    if (!flow.confirmationBinding || !sameHash(flow.confirmationBinding, hash(binding ?? ''))) {
      throw new Refused('OAUTH_STATE', 'open the relay confirmation link in this browser again');
    }
  }

  /** Hide public boards below triage, and refuse actions below write without hiding readable private boards. */
  function authorize(permission, linked, write) {
    if (!permission.allowed) {
      if (permission.hidden) throw new Refused('BOARD_NOT_LINKED', 'link this board to a readable GitHub repository before using it');
      throw new Refused('NO_REPO_ACCESS', 'GitHub cannot confirm your repository access; ask for access and retry');
    }
    if (write && !['write', 'maintain', 'admin'].includes(permission.role)) throw new Refused('WRITE_REQUIRED', 'board actions and token management need repository write access; ask its owner for access');
    return { ...linked, permission: permission.role, public: permission.public };
  }

  /** Require current repository roles; cache visibility for ten minutes but never authorize a write from cache. */
  async function access(row, board, write) {
    const linked = db.prepare('SELECT * FROM relay_boards WHERE id=?').get(board);
    if (!linked) throw new Refused('BOARD_NOT_LINKED', 'link this board to a readable GitHub repository before using it');
    const key = row.user_id + ':' + board;
    const prior = permissions.get(key);
    const started = now();
    if (!write && prior && started >= prior.checked && started - prior.checked < ACCESS_WINDOW_MS) return authorize(prior, linked, false);
    let repo;
    try {
      repo = await github.access({ id: row.user_id, login: row.login }, linked.repository);
      if (String(repo.id) !== linked.repository_id) throw new Refused('NO_REPO_ACCESS', 'the linked repository identity changed; ask the coordinator to link the correct board');
    } catch (error) {
      if (error.code === 'NO_REPO_ACCESS' && (!permissions.has(key) || permissions.get(key).checked <= started)) permissions.set(key, { checked: started, allowed: false });
      throw error;
    }
    const current = db.prepare('SELECT repository_id FROM relay_boards WHERE id=?').get(board);
    if (!current || current.repository_id !== linked.repository_id) throw new Refused('BOARD_NOT_LINKED', 'link this board again before using it');
    const canRead = ['read', 'triage', 'write', 'maintain', 'admin'].includes(repo.permission);
    const hidden = repo.public && !['triage', 'write', 'maintain', 'admin'].includes(repo.permission);
    const checked = { checked: started, allowed: canRead && !hidden, hidden, role: repo.permission, public: repo.public };
    if (!permissions.has(key) || permissions.get(key).checked <= started) permissions.set(key, checked);
    return authorize(checked, linked, write);
  }

  const auth = {
    /** Start a browser authorization with a distinct CSRF cookie binding and PKCE verifier. */
    beginWeb() {
      pruneFlows();
      const state = random('');
      const binding = random('');
      const verifier = random('');
      webFlows.set(hash(state), { binding: hash(binding), verifier, expires: now() + 10 * 60_000 });
      return { authorizationURL: github.authorizeURL(state, createHash('sha256').update(verifier).digest('base64url')), binding };
    },
    /** Consume a matching browser grant once; neither verifier nor GitHub token enters SQLite. */
    async finishWeb(state, code, binding) {
      open();
      if (typeof state !== 'string' || typeof binding !== 'string') throw new Refused('OAUTH_STATE', 'start sign-in again in this browser');
      const key = hash(state);
      const flow = webFlows.get(key);
      if (!flow || flow.expires <= now() || !sameHash(flow.binding, hash(binding))) throw new Refused('OAUTH_STATE', 'the sign-in state expired or does not match this browser; start again');
      webFlows.delete(key);
      return signedIn(await github.exchangeCode(code, flow.verifier));
    },
    /** Give the CLI a relay ticket; the GitHub device credential remains in RAM. */
    async beginDevice({ intent } = {}) {
      pruneFlows();
      if (intent !== undefined && (!intent || typeof intent !== 'object' || Array.isArray(intent))) {
        throw new Refused('BAD_REQUEST', 'start a relay sign-in with a valid board confirmation');
      }
      let pendingIntent;
      if (intent !== undefined) {
        const expected = Object.hasOwn(intent, 'replaces') ? 'board,boardName,host,replaces,repository' : 'board,boardName,host,repository';
        if (Object.keys(intent).sort().join(',') !== expected) {
          throw new Refused('BAD_REQUEST', 'start a relay sign-in with exactly one board confirmation');
        }
        identifier(intent.board, 'BAD_BOARD');
        if (Object.hasOwn(intent, 'replaces')) identifier(intent.replaces, 'BAD_BOARD');
        const repository = repositoryName(intent.repository);
        if (typeof intent.host !== 'string' || !intent.host || intent.host.length > 255 || /[\u0000-\u001f\u007f]/u.test(intent.host) ||
            typeof intent.boardName !== 'string' || !intent.boardName.trim() || intent.boardName.length > 200 || /[\u0000-\u001f\u007f]/u.test(intent.boardName)) {
          throw new Refused('BAD_REQUEST', 'start a relay sign-in with a valid board name and machine host');
        }
        pendingIntent = Object.freeze({ board: intent.board, repository, host: intent.host, boardName: intent.boardName,
          ...(Object.hasOwn(intent, 'replaces') ? { replaces: intent.replaces } : {}) });
      }
      const grant = await github.startDevice();
      pruneFlows();
      const ticket = random('pd_');
      const grantExpires = now() + grant.expiresIn * 1000;
      const deviceTicketHash = hash(ticket);
      const flow = { deviceCode: grant.deviceCode, deviceTicketHash, grantExpires, expires: grantExpires, interval: grant.interval, next: now() + grant.interval * 1000,
        cancelled: false, completed: false, terminalOutcome: null, sessionId: null, pollSettled: null,
        ...(pendingIntent ? { intent: pendingIntent, confirmationTicket: random('pc_') } : {}) };
      deviceFlows.set(deviceTicketHash, flow);
      if (flow.confirmationTicket) deviceConfirmations.set(hash(flow.confirmationTicket), flow);
      return { ticket, ...(flow.confirmationTicket ? { confirmationTicket: flow.confirmationTicket } : {}), userCode: grant.userCode,
        verificationURL: grant.verificationURL, expiresIn: grant.expiresIn, interval: grant.interval };
    },
    /** Throttle device polling, honor slow-down, and consume a successful grant only once. */
    async pollDevice(ticket) {
      open();
      if (typeof ticket !== 'string') throw new Refused('OAUTH_EXPIRED', 'start CLI sign-in again');
      const key = hash(ticket);
      const flow = deviceFlows.get(key);
      if (!flow || flow.cancelled || flow.completed) throw new Refused('OAUTH_EXPIRED', 'CLI sign-in expired; start again');
      if (deviceFlowExpiry(flow) <= now() && !flow.busy) {
        deviceFlows.delete(key);
        if (flow?.confirmationTicket) deviceConfirmations.delete(hash(flow.confirmationTicket));
        if (flow && !flow.confirmed) discardDeviceSession(flow);
        throw new Refused('OAUTH_EXPIRED', 'CLI sign-in expired; start again');
      }
      if (flow.intent) {
        if (flow.declined) {
          discardDeviceSession(flow);
          deviceFlows.delete(key);
          deviceConfirmations.delete(hash(flow.confirmationTicket));
          throw new Refused('OAUTH_DENIED', 'the person declined to link this board; run pullboard relay on again to start a new sign-in');
        }
        if (flow.confirmed) {
          deviceFlows.delete(key);
          deviceConfirmations.delete(hash(flow.confirmationTicket));
          return { ...flow.session, linkConfirmed: true, linkedBoard: flow.intent.board };
        }
        if (flow.session) return { pending: true, pendingConfirmation: true, confirmationExpiresIn: Math.max(1, Math.ceil((flow.expires - now()) / 1000)), retryAfter: flow.interval };
      }
      if (flow.busy || flow.next > now()) return { pending: true, retryAfter: Math.max(1, Math.ceil((flow.next - now()) / 1000)) };
      flow.next = now() + flow.interval * 1000;
      flow.busy = true;
      let result;
      let settle;
      flow.pollSettled = new Promise(resolve => { settle = resolve; });
      try {
        try { result = await github.pollDevice(flow.deviceCode); }
        catch (error) {
          if (flow.cancelled) throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
          if (['OAUTH_DENIED', 'OAUTH_EXPIRED'].includes(error.code)) {
            // Retain the ticket hash until expiry so a racing cancellation can confirm cleanup.
            flow.deviceCode = null;
            flow.terminalOutcome = error.code;
            flow.completed = true;
          }
          throw error;
        }
        if (flow.cancelled) throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
        if (flow.expires <= now()) {
          deviceFlows.delete(key);
          if (flow.confirmationTicket) deviceConfirmations.delete(hash(flow.confirmationTicket));
          if (!flow.confirmed) discardDeviceSession(flow);
          throw new Refused('OAUTH_EXPIRED', 'CLI sign-in expired; start again');
        }
        if (flow.declined) {
          deviceFlows.delete(key);
          if (flow.confirmationTicket) deviceConfirmations.delete(hash(flow.confirmationTicket));
          throw new Refused('OAUTH_DENIED', 'the person declined to link this board; run pullboard relay on again to start a new sign-in');
        }
        if (result.pending) {
          if (result.slow) flow.interval += 5;
          if (Number.isFinite(result.interval) && result.interval > flow.interval) flow.interval = result.interval;
          flow.next = now() + flow.interval * 1000;
          return { pending: true, retryAfter: flow.interval };
        }
        const session = await signedIn(result, { cancelled: () => flow.cancelled });
        flow.deviceCode = null;
        flow.sessionId = session.id;
        flow.sessionExpires = session.expires;
        flow.completed = !flow.intent;
        deviceSessionReceipts.set(key, { sessionId: session.id, expires: session.expires, revoked: false });
        if (flow.cancelled || flow.expires <= now()) {
          db.prepare("UPDATE relay_credentials SET revoked=1 WHERE id=? AND kind='session'").run(flow.sessionId);
          deviceSessionReceipts.get(key).revoked = true;
          throw flow.cancelled
            ? new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked')
            : new Refused('OAUTH_EXPIRED', 'CLI sign-in expired; start again');
        }
        if (flow.intent) {
          flow.session = session;
          if (flow.declined || flow.expires <= now()) {
            discardDeviceSession(flow);
            deviceFlows.delete(key);
            deviceConfirmations.delete(hash(flow.confirmationTicket));
            throw new Refused(flow.declined ? 'OAUTH_DENIED' : 'OAUTH_EXPIRED', 'the person confirmation ended before sign-in completed; run pullboard relay on again');
          }
          flow.expires = now() + 10 * 60_000;
          return { pending: true, pendingConfirmation: true, confirmationExpiresIn: 600, retryAfter: flow.interval };
        }
        return session;
      } finally {
        flow.busy = false;
        flow.pollSettled = null;
        settle();
      }
    },
    /** Cancel one bearer-ticket flow and revoke only the session it minted, if any. */
    async cancelDevice(ticket) {
      open();
      if (typeof ticket !== 'string' || !/^pd_[A-Za-z0-9_-]{43}$/u.test(ticket)) return { cancelled: false };
      const key = hash(ticket);
      let flow = deviceFlows.get(key);
      let receipt = deviceSessionReceipts.get(key);
      if (flow && flow.expires <= now() && !flow.busy) {
        deviceFlows.delete(key);
        flow = null;
      }
      if (receipt && receipt.expires <= now()) {
        deviceSessionReceipts.delete(key);
        receipt = null;
      }
      if (!flow && !receipt) return { cancelled: false };
      if (flow) {
        flow.cancelled = true;
        const pollSettled = flow.pollSettled;
        if (pollSettled) await pollSettled;
        flow.deviceCode = null;
        receipt = deviceSessionReceipts.get(key) ?? receipt;
      }
      const sessionId = receipt?.sessionId ?? flow?.sessionId;
      const sessionExpires = receipt?.expires ?? flow?.sessionExpires;
      if (sessionId && !Number.isSafeInteger(sessionExpires)) throw new Refused('OAUTH_CLEANUP', 'the relay cannot confirm cleanup for this sign-in; retry or sign in again');
      if (sessionId && !receipt?.revoked) {
        db.prepare("UPDATE relay_credentials SET revoked=1 WHERE id=? AND kind='session' AND expires=?").run(sessionId, sessionExpires);
        if (receipt) receipt.revoked = true;
      }
      if (flow) {
        discardDeviceSession(flow);
        flow.sessionId = null;
        if (flow.confirmationTicket) deviceConfirmations.delete(hash(flow.confirmationTicket));
      }
      return { cancelled: true };
    },
    /** Start a cookie-bound browser visit for the separate one-use board confirmation nonce. */
    openDeviceConfirmation(ticket) {
      const { flow } = confirmation(ticket);
      const binding = random('');
      flow.confirmationBinding = hash(binding);
      return { binding, cookieMaxAge: Math.max(1, Math.ceil((flow.grantExpires - now()) / 1000) + 600) };
    },
    /** Read only the immutable board intent and whether the matching device grant is ready. */
    deviceConfirmationStatus(ticket, binding) {
      const { flow } = confirmation(ticket);
      confirmationBinding(flow, binding);
      return { ready: Boolean(flow.session), confirmed: Boolean(flow.confirmed), declined: Boolean(flow.declined),
        ...(flow.session ? { account: flow.session.user.login } : {}), intent: flow.intent };
    },
    /** Confirm or decline the exact board intent; only approval links it and releases the session to the CLI. */
    async confirmDevice(ticket, binding, decision) {
      const { flow } = confirmation(ticket);
      confirmationBinding(flow, binding);
      if (decision === 'decline') {
        if (flow.confirmed) throw new Refused('OAUTH_STATE', 'this board link was already confirmed');
        if (flow.confirming) throw new Refused('OAUTH_PENDING', 'the board link is being confirmed; wait for the relay page');
        flow.declined = true;
        discardDeviceSession(flow);
        return { declined: true };
      }
      if (decision !== 'confirm') throw new Refused('BAD_REQUEST', 'choose confirm or decline on the relay page');
      if (!flow.session) throw new Refused('OAUTH_PENDING', 'finish GitHub sign-in before confirming this board link');
      if (!flow.confirmed) {
        if (flow.confirming) throw new Refused('OAUTH_PENDING', 'the board link is being confirmed; wait for the relay page');
        flow.confirming = true;
        try {
          await auth.linkBoard(flow.session.token, flow.intent.board, flow.intent.repository, flow.expires, flow.intent.replaces ?? null);
          flow.confirmed = true;
          flow.deliveryExpires = now() + 10 * 60_000;
        } finally { flow.confirming = false; }
      }
      return { confirmed: true, board: flow.intent.board };
    },
    /** Authenticate a human or a scoped agent; every board write asks GitHub again. */
    async authenticate(token, { board, write = false } = {}) {
      const row = credential(token);
      if (row.kind === 'board' && board !== row.board) throw new Refused('TOKEN_BOARD', 'use this token only on its named board; obtain another token for another board');
      if (row.kind === 'machine' && board !== undefined && board !== row.board) throw new Refused('TOKEN_BOARD', 'use this machine credential only on its linked board; ask the paired phone to link another board');
      let repository;
      if (board !== undefined) {
        identifier(board, 'BAD_BOARD');
        repository = await access(row, board, write);
        if (board !== null && board !== undefined && !db.prepare('SELECT 1 FROM relay_boards WHERE id=?').get(board)) throw new Refused('BOARD_NOT_LINKED', 'link this board again before using it');
        credential(token); // A revocation or expiry during the awaited provider call must take effect.
      }
      return { id: row.id, kind: row.kind, user: { id: row.user_id, login: row.login }, ...(row.board ? { board: row.board, ...(row.kind === 'machine' ? { machine: row.agent } : { agent: row.agent }) } : {}), ...(row.root ? { root: true, ...(row.lineage ? { lineage: row.lineage } : {}) } : {}), ...(repository ? { permission: repository.permission, public: repository.public } : {}), expires: row.expires };
    },
    /**
     * Accept a link only from a signed-in human with current repository write access. A repository has one team
     * board: a second board for it is refused, unless this link replaces the named board after relay off [E12].
     */
    async linkBoard(token, board, repository, deadline = Infinity, replaces = null) {
      identifier(board, 'BAD_BOARD');
      repositoryName(repository);
      if (replaces !== null && replaces !== undefined) identifier(replaces, 'BAD_BOARD');
      const row = credential(token);
      if (row.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'sign in as a person to link a board');
      const repo = await github.access({ id: row.user_id, login: row.login }, repository);
      authorize({ allowed: true, hidden: false, role: repo.permission, public: repo.public }, {}, true);
      credential(token);
      if (deadline <= now()) throw new Refused('OAUTH_EXPIRED', 'the relay confirmation expired before the board link was made; run pullboard relay on again');
      open();
      lifecycle(() => {
        if (db.prepare('SELECT 1 FROM relay_cleanup WHERE board=?').get(board)) throw new Refused('RELAY_CLEANUP', 'finish pending board cleanup before linking again');
        const existing = db.prepare('SELECT * FROM relay_boards WHERE id=?').get(board);
        if (existing && existing.repository_id !== String(repo.id)) throw new Refused('BOARD_LINK_CONFLICT', 'use a new board identifier for a different repository');
        // A repository has one active link: an off board, with its receipt, or one under cleanup no longer counts [E12].
        const active = db.prepare("SELECT id FROM relay_boards WHERE repository_id=? AND id<>? AND id NOT IN (SELECT board FROM relay_board_off) AND id NOT IN (SELECT board FROM relay_cleanup) ORDER BY linked_at DESC, id").all(String(repo.id), board);
        if (replaces !== null && replaces !== undefined && !active.some((entry) => entry.id === replaces)) {
          throw new Refused('BOARD_REPLACE', `board ${replaces} is not this repository's active board, so this link replaces nothing; run pullboard relay on again to join the repository's board`);
        }
        const other = active.find((entry) => entry.id !== replaces);
        if (other) throw new Refused('BOARD_REPO_LINKED', `${repo.name} already has board ${other.id}, and a repository has one team board; pull pullboard.json from main, which names that board, then run pullboard relay on again to join it`);
        // Relinking after relay off turns the old link off in the same transaction, with its receipt [E12].
        if (replaces) db.prepare('INSERT INTO relay_board_off (board,repository_id,replaced_by,user_id,at) VALUES (?,?,?,?,?)').run(replaces, String(repo.id), board, row.user_id, now());
        db.prepare('INSERT INTO relay_boards (id,repository,repository_id,linked_at,storage_account) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository,storage_account=COALESCE(relay_boards.storage_account,excluded.storage_account)').run(board, repo.name, String(repo.id), now(), row.user_id);
        permissions.delete(row.user_id + ':' + board);
      });
      return { id: board, repository: repo.name, repositoryID: String(repo.id), ...(replaces ? { replaced: replaces } : {}) };
    },
    /** The receipt that turned a board's link off when a relink replaced it, or null [E12]. */
    boardOff(board) {
      open();
      return db.prepare('SELECT board,replaced_by AS replacedBy,user_id AS userId,at FROM relay_board_off WHERE board=?').get(board) ?? null;
    },
    /** Internal maintenance inventory; HTTP callers must still pass the normal authorization boundary. */
    linkedBoards() {
      open();
      return db.prepare('SELECT id,repository,linked_at AS linkedAt FROM relay_boards ORDER BY id').all();
    },
    /** Resolve a stable storage account; only the service's authenticated writer may assign an older unassigned link. */
    storageAccount(board, authenticatedUserId) {
      identifier(board, 'BAD_BOARD');
      return lifecycle(() => {
        const saved = db.prepare('SELECT storage_account FROM relay_boards WHERE id=?').get(board);
        if (!saved) throw new Refused('BOARD_NOT_LINKED', 'Link this board before using relay storage.');
        if (saved.storage_account === null && authenticatedUserId !== undefined) {
          if (typeof authenticatedUserId !== 'string' || !db.prepare('SELECT 1 FROM relay_users WHERE id=?').get(authenticatedUserId)) throw new Refused('BAD_SENDER', 'Use the authenticated account when assigning existing relay storage.');
          db.prepare('UPDATE relay_boards SET storage_account=? WHERE id=? AND storage_account IS NULL').run(authenticatedUserId, board);
        }
        return db.prepare('SELECT id,login FROM relay_users WHERE id=(SELECT storage_account FROM relay_boards WHERE id=?)').get(board) ?? null;
      });
    },
    /** Internal account inventory for quota checks; repository authorization still governs every public board request. */
    storageBoards(account) {
      open();
      if (typeof account !== 'string' || !account) throw new Refused('BAD_SENDER', 'Name the authenticated storage account.');
      return db.prepare('SELECT id FROM relay_boards WHERE storage_account=? ORDER BY id').all(account).map(row => row.id);
    },
    /** Hold one shared lifecycle lock through every journal use and expiry decision. */
    withBoard(board, work) {
      identifier(board, 'BAD_BOARD');
      return lifecycle(() => {
        const link = db.prepare('SELECT id,repository,linked_at AS linkedAt FROM relay_boards WHERE id=?').get(board);
        if (!link) throw new Refused('BOARD_NOT_LINKED', 'link this board again before using it');
        return work(link);
      });
    },
    /** Persist unlink intent and revoke scoped access before files are removed; retry after crashes. */
    forgetBoard(board) {
      identifier(board, 'BAD_BOARD');
      lifecycle(() => {
        db.prepare('INSERT OR IGNORE INTO relay_cleanup (board) VALUES (?)').run(board);
        db.prepare('DELETE FROM relay_deleted_credentials WHERE expires<=?').run(now());
        db.prepare('INSERT OR REPLACE INTO relay_deleted_credentials (hash,board,expires) SELECT hash,board,expires FROM relay_credentials WHERE board=? AND revoked=0 AND expires>?').run(board, now());
        db.prepare('DELETE FROM relay_credentials WHERE board=?').run(board);
        // A person unlinked the board; a later link starts its seats afresh with the new journal.
        db.prepare('DELETE FROM relay_seats WHERE board=?').run(board);
        db.prepare('DELETE FROM relay_coordinator_events WHERE board=?').run(board);
        db.prepare('DELETE FROM relay_boards WHERE id=?').run(board);
      });
      for (const key of permissions.keys()) if (key.endsWith(':' + board)) permissions.delete(key);
    },
    /** Keep retrying cleanup exclusive through file removal and intent completion, blocking relink races. */
    withCleanup(board, work) {
      identifier(board, 'BAD_BOARD');
      return lifecycle(() => db.prepare('SELECT 1 FROM relay_cleanup WHERE board=?').get(board) ? work() : undefined);
    },
    /** Inventory durable unlink intents without exposing them through the HTTP boundary. */
    pendingCleanup() { open(); return db.prepare('SELECT board FROM relay_cleanup ORDER BY board').all().map((row) => row.board); },
    /** Remove an unlink intent only after its journal, sidecars and managed backups are gone. */
    finishCleanup(board) { identifier(board, 'BAD_BOARD'); lifecycle(() => db.prepare('DELETE FROM relay_cleanup WHERE board=?').run(board)); },
    /** Register a synchronous device-session boundary shared by every credential use, including auth routes. */
    addSessionGuard(guard) {
      open();
      if (typeof guard !== 'function') throw new Refused('RELAY_CONFIG', 'configure a synchronous session guard before serving relay authentication');
      sessionGuards.add(guard);
      return () => sessionGuards.delete(guard);
    },
    /** List only linked boards the current credential and GitHub account may read. */
    async boardsFor(token) {
      const row = credential(token);
      const boards = row.kind !== 'session' ? db.prepare('SELECT * FROM relay_boards WHERE id=?').all(row.board) : db.prepare('SELECT * FROM relay_boards ORDER BY id').all();
      const visible = [];
      for (const board of boards) {
        try { await auth.authenticate(token, { board: board.id }); visible.push({ id: board.id, repository: board.repository, linkedAt: board.linked_at }); }
        catch (error) { if (!['NO_REPO_ACCESS', 'BOARD_NOT_LINKED'].includes(error.code)) throw error; }
      }
      return visible;
    },
    /** Retain the minimum replay engine after any agent or machine credential, including expired and revoked ones. */
    minimumEngineVersion(board) {
      open();
      identifier(board, 'BAD_BOARD');
      // Only an engine that enforces approvers may read or write a board that names them [E4,E20].
      if (auth.boardApprovers(board)) return PEOPLE_ENGINE;
      // Machine and agent credentials now carry engine-48 seat provenance; older clients would skip it.
      if (db.prepare("SELECT 1 FROM relay_credentials WHERE board=? AND kind IN ('machine','board') LIMIT 1").get(board)) return VERIFIER_STANDING_ENGINE;
      return db.prepare("SELECT 1 FROM relay_credentials WHERE board=? AND kind='board' LIMIT 1").get(board) ? 3 : 1;
    },
    /**
     * The GitHub logins this board names as its approvers, or null when it names none and behaves as before [E4].
     *
     * @param {string} board
     * @returns {string[] | null}
     */
    boardApprovers(board) {
      open();
      const row = db.prepare('SELECT approvers FROM relay_boards WHERE id=?').get(board);
      return row?.approvers ? JSON.parse(row.approvers) : null;
    },
    /**
     * Whether this principal may act for a board that names approvers: true or false when it names them, null when
     * it names none. A machine or agent credential acts for the person who minted it [E4,E20].
     */
    isApprover(board, principal) {
      const approvers = auth.boardApprovers(board);
      return approvers ? approvers.includes(principal.user.login) : null;
    },
    /**
     * Set a board's approvers from its pullboard.json, signed in as a person. The first list is the linking person's
     * to set; after that only a current approver changes it, so a change takes effect only once an approver makes
     * it. An empty list removes them, and the board behaves as before [E4].
     *
     * @param {string} token - a person session
     * @param {string} board
     * @param {string[]} approvers - GitHub logins
     */
    async setBoardApprovers(token, board, approvers) {
      identifier(board, 'BAD_BOARD');
      if (!Array.isArray(approvers) || approvers.length > 50 || new Set(approvers).size !== approvers.length
        || approvers.some((login) => typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login))) {
        throw new Refused('BAD_APPROVERS', 'name approvers as distinct GitHub logins, at most fifty');
      }
      const principal = await auth.authenticate(token, { board, write: true });
      if (principal.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'set approvers signed in as yourself');
      const current = auth.boardApprovers(board);
      const linker = db.prepare('SELECT storage_account FROM relay_boards WHERE id=?').get(board)?.storage_account;
      const allowed = current ? current.includes(principal.user.login) : linker === null || linker === undefined || linker === principal.user.id;
      if (!allowed) throw new Refused('NOT_APPROVER', `${principal.user.login} is not an approver of this board; an approver signs in and runs pullboard relay on to change the list`);
      db.prepare('UPDATE relay_boards SET approvers=? WHERE id=?').run(approvers.length ? JSON.stringify([...approvers].sort()) : null, board);
      return { board, approvers: approvers.length ? [...approvers].sort() : null };
    },
    /** Give a foreground person one board-bound machine delegate, never another person credential. */
    async issueMachine(token, { board, machine, host, name, expiresIn = MAX_TTL }) {
      identifier(board, 'BAD_BOARD');
      identifier(machine, 'BAD_MACHINE');
      const label = computerName(name);
      if (host !== undefined && (typeof host !== 'string' || !host.trim() || host.length > 255 || /[\u0000-\u001f\u007f]/u.test(host))) {
        throw new Refused('BAD_REQUEST', 'send the joining computer’s host name as plain text of at most 255 characters');
      }
      if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_TTL) throw new Refused('BAD_EXPIRY', 'choose a machine expiry of at most thirty days');
      const principal = await auth.authenticate(token, { board, write: true });
      if (principal.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'approve this machine from the signed-in phone');
      credential(token);
      const issued = issue(principal.user, 'machine', board, machine, expiresIn);
      if (host !== undefined) db.prepare('UPDATE relay_credentials SET host=? WHERE id=?').run(host, issued.id);
      if (label !== undefined) db.prepare('UPDATE relay_credentials SET name=? WHERE id=?').run(label, issued.id);
      return { ...issued, board, machine };
    },
    /** List live computer identities only for this board's machine or a freshly authorized person. */
    async listMachines(token, board) {
      identifier(board, 'BAD_BOARD');
      const principal = await auth.authenticate(token, { board, write: true });
      if (!['session', 'machine'].includes(principal.kind)) throw new Refused('HUMAN_REQUIRED', 'use this board’s machine credential or the signed-in phone to list joined computers');
      credential(token);
      // Each computer is listed once, by the host name it sent when it joined, with its first join and last contact.
      return db.prepare("SELECT agent AS machine, MAX(name) AS name, MIN(created) AS created, MAX(seen) AS seen FROM relay_credentials WHERE board=? AND kind='machine' AND revoked=0 AND expires>? GROUP BY agent ORDER BY agent")
        .all(board, now()).map(row => ({ machine: row.machine, name: row.name ?? null, created: row.created ?? null, seen: row.seen ?? null }));
    },
    /**
     * Mint an agent credential scoped to one board (#579). The machine credential, or a person,
     * first-mints only a seat the relay never issued a token to, and that seat is machine-origin
     * for good. A seat's own current token renews it, revoking itself. Its creator may reissue a
     * lost token for a seat it registered, revoking the old ones. A seat's first token from a
     * creator comes only with its registration move (`enrollSeat`), never from this route.
     */
    async issueToken(token, { board, agent, expiresIn = tokenTTL, recover = false, registration }) {
      identifier(board, 'BAD_BOARD');
      identifier(agent, 'BAD_AGENT');
      expiry(expiresIn, 'token');
      if (registration !== undefined) throw new Refused('REGISTRATION_IN_MOVE', 'a seat receipt counts only inside its registration move; post the move with its receipt from the creating seat');
      if (typeof recover !== 'boolean') throw new Refused('BAD_REQUEST', 'send recover as true or false');
      const principal = await auth.authenticate(token, { board, write: true });
      return lifecycle(() => {
        const current = credential(token);
        const existing = seat(board, agent);
        if (principal.kind === 'board') {
          if (!recover && principal.agent === agent) {
            const renewed = issue(principal.user, 'board', board, agent, expiresIn, Boolean(current.root), current.lineage ?? null);
            db.prepare('UPDATE relay_credentials SET revoked=1 WHERE id=?').run(current.id);
            return { ...renewed, board, agent };
          }
          const claim = !existing && recover ? registrationClaim(board, agent) : null;
          if (recover && claim?.creator === principal.agent && agent !== principal.agent) {
            // A receipt published without its enrollment: the creator rolls the first mint forward.
            return firstMint({ id: current.user_id }, board, agent, tokenTTL,
              { origin: 'registered', creator: claim.creator, sequence: claim.sequence, digest: claim.digest });
          }
          if (recover && existing?.origin === 'registered' && existing.creator === principal.agent && agent !== principal.agent) {
            db.prepare("UPDATE relay_credentials SET revoked=1 WHERE board=? AND kind='board' AND agent=?").run(board, agent);
            return { ...issue(principal.user, 'board', board, agent, expiresIn), board, agent };
          }
          throw new Refused('TOKEN_AGENT', recover
            ? 'only the seat that registered this one reissues its token; ask its creator'
            : 'an agent token renews only its own seat; a new seat gets its first token from its creator\'s registration');
        }
        if (recover) throw new Refused('TOKEN_AGENT', 'only the seat that registered this one reissues its token; ask its creator');
        if (existing) {
          throw new Refused('TOKEN_EXISTS', agent === 'coordinator'
            ? 'the coordinator already has a token; it renews with its own, or the person reissues it with pullboard relay on'
            : 'this seat already had a token; it renews only with its own current token, or its creator reissues it');
        }
        // A published receipt claims its target even before enrollment finishes: no machine race.
        if (registrationClaim(board, agent)) {
          throw new Refused('TOKEN_EXISTS', 'a creator registered this seat; its first token comes only through that registration or its creator');
        }
        return firstMint(principal.user, board, agent, expiresIn, { origin: 'machine' });
      });
    },
    /** Wire the relay journal's receipt lookup; token issuance then honors every published claim. */
    setRegistrationClaims(reader) {
      if (typeof reader !== 'function') throw new Refused('RELAY_CONFIG', 'configure a seat receipt reader');
      registrationClaim = reader;
    },
    /**
     * Give a registration move's target its first token, inside the board lock that appended the
     * move (#579). The creator is the authenticated agent token that sent the move; the target
     * must be new to the relay. An exact retry returns the same issuance without a token.
     */
    enrollSeat(token, board, receipt) {
      identifier(board, 'BAD_BOARD');
      return lifecycle(() => {
        const current = credential(token);
        if (current.kind !== 'board' || current.agent !== receipt.creator || current.board !== board) {
          throw new Refused('REGISTRATION_SENDER', 'register a seat with the creating seat\'s own token');
        }
        const existing = seat(board, receipt.target);
        if (existing) {
          if (existing.origin === 'registered' && existing.creator === receipt.creator && existing.sequence === receipt.sequence && existing.digest === receipt.digest) {
            return { id: existing.first_id, created: existing.first_created, expires: existing.first_expires, board, agent: receipt.target, retried: true };
          }
          throw new Refused('SEAT_TAKEN', `the relay already issued ${receipt.target} a token, so it cannot be registered again; register the next free name`);
        }
        return firstMint({ id: current.user_id }, board, receipt.target, tokenTTL,
          { origin: 'registered', creator: receipt.creator, sequence: receipt.sequence, digest: receipt.digest });
      });
    },
    /** Read one seat's first-mint record for the registration check before a move is appended. */
    seatRecord(board, agent) {
      open();
      identifier(board, 'BAD_BOARD');
      identifier(agent, 'BAD_AGENT');
      const row = seat(board, agent);
      return row && { origin: row.origin, creator: row.creator, sequence: row.sequence, digest: row.digest };
    },
    /**
     * Set up the coordinator's token from a person session only (#579): the first one on a board
     * (bootstrap), a fresh one after loss, expiry or revocation, or for another of the person's
     * machines (reissue), or the person's reset of a coordinator first minted by the machine
     * (reset), which revokes every older coordinator token. A reissue revokes the token it names
     * as replaced. Each issue leaves an audit row naming the session, the revoked ids and the new id.
     */
    async issueCoordinator(token, { board, expiresIn = tokenTTL, replaces }) {
      identifier(board, 'BAD_BOARD');
      expiry(expiresIn, 'coordinator');
      const principal = await auth.authenticate(token, { board, write: true });
      if (principal.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'only the person sets up the coordinator credential: run pullboard relay on in the main checkout');
      return lifecycle(() => {
        const current = credential(token);
        const existing = seat(board, 'coordinator');
        const reason = !existing ? 'bootstrap' : existing.origin === 'root' ? 'reissue' : existing.origin === 'machine' ? 'reset' : null;
        if (!reason) throw new Refused('COORDINATOR_SEAT', 'the coordinator seat on this board was registered by another seat; unlink and link the board again');
        if (replaces !== undefined && typeof replaces !== 'string') throw new Refused('BAD_REQUEST', 'name the coordinator token id this one replaces');
        // A reset revokes every machine-minted coordinator token; a reissue revokes the one it
        // replaces, so each of the person's linked machines keeps its own coordinator token.
        const revoked = db.prepare("SELECT id FROM relay_credentials WHERE board=? AND kind='board' AND agent='coordinator' AND revoked=0 AND expires>?").all(board, now())
          .map((row) => row.id).filter((id) => reason === 'reset' || id === replaces);
        // A replacement keeps its machine's lineage; a token for another machine starts a new one.
        const replaced = replaces === undefined ? null : db.prepare("SELECT lineage FROM relay_credentials WHERE id=? AND board=? AND kind='board' AND agent='coordinator' AND root=1").get(replaces, board);
        const lineage = reason !== 'reset' && replaced?.lineage ? replaced.lineage : randomUUID();
        for (const id of revoked) db.prepare('UPDATE relay_credentials SET revoked=1 WHERE id=?').run(id);
        const issued = reason === 'reissue'
          ? { ...issue(principal.user, 'board', board, 'coordinator', expiresIn, true, lineage), board, agent: 'coordinator' }
          : firstMint(principal.user, board, 'coordinator', expiresIn, { origin: 'root', root: true, lineage });
        db.prepare('INSERT INTO relay_coordinator_events (id,board,reason,session_id,revoked,issued_id,at) VALUES (?,?,?,?,?,?,?)')
          .run(randomUUID(), board, reason, current.id, JSON.stringify(revoked), issued.id, issued.created);
        return { ...issued, root: true, reason };
      });
    },
    /** List only owned board-token metadata after a fresh repository write check, never bearer values or hashes. */
    async listTokens(token, board) {
      identifier(board, 'BAD_BOARD');
      const principal = await auth.authenticate(token, { board, write: true });
      if (!['session', 'machine'].includes(principal.kind)) throw new Refused('HUMAN_REQUIRED', 'use this board’s machine credential to list agent token ids');
      credential(token);
      return db.prepare('SELECT id,board,agent,created,expires,revoked FROM relay_credentials WHERE user_id=? AND kind=? AND board=? ORDER BY agent,id')
        .all(principal.user.id, 'board', board).map((row) => ({ ...row, revoked: Boolean(row.revoked) }));
    },
    /** The person-made coordinator credential events on one board, with ids and times and no bearer values. */
    async coordinatorEvents(token, board) {
      identifier(board, 'BAD_BOARD');
      const principal = await auth.authenticate(token, { board, write: true });
      if (!['session', 'machine'].includes(principal.kind)) throw new Refused('HUMAN_REQUIRED', 'use this board’s machine credential to list agent token ids');
      credential(token);
      return db.prepare('SELECT id,reason,session_id,revoked,issued_id,at FROM relay_coordinator_events WHERE board=? ORDER BY at,rowid').all(board)
        .map((row) => ({ id: row.id, reason: row.reason, session: row.session_id, revoked: JSON.parse(row.revoked), issued: row.issued_id, at: row.at }));
    },
    /** Mint a short-lived grant only after an authenticated phone approves an immutable action context. */
    async issueActionGrant(token, value) {
      const context = approvalContext(value);
      const principal = await auth.authenticate(token, { board: context.publisher, write: true });
      if (principal.kind !== 'session' || principal.user.id !== context.account || context.action === 'link') throw new Refused('HUMAN_REQUIRED', 'approve this native action from the signed-in paired phone');
      credential(token);
      const grant = random('pg_');
      const expires = Math.min(context.expires, now() + 120_000);
      if (expires <= now()) throw new Refused('PHONE_APPROVAL_EXPIRED', 'request a fresh phone approval explicitly');
      lifecycle(() => {
        if (db.prepare('SELECT 1 FROM relay_action_grants WHERE request=?').get(context.id)) throw new Refused('PHONE_APPROVAL_USED', 'this action was already approved; use its encrypted reply');
        db.prepare('INSERT INTO relay_action_grants(hash,request,user_id,context,expires) VALUES(?,?,?,?,?)').run(hash(grant), context.id, principal.user.id, JSON.stringify(context), expires);
      });
      return { grant, expires };
    },
    /** Atomically consume once before dispatch; an interrupted action needs another explicit phone approval. */
    async consumeActionGrant(token, grant, value) {
      const context = approvalContext(value);
      const principal = await auth.authenticate(token, { board: context.publisher, write: true });
      if (principal.kind !== 'machine' || principal.user.id !== context.account || principal.machine !== context.machine ||
          typeof grant !== 'string' || !/^pg_[A-Za-z0-9_-]{43}$/u.test(grant)) throw new Refused('HUMAN_REQUIRED', 'use the one-time grant approved for this exact native command');
      credential(token);
      lifecycle(() => {
        const row = db.prepare('SELECT * FROM relay_action_grants WHERE hash=?').get(hash(grant));
        if (!row || row.used || row.expires <= now() || row.user_id !== principal.user.id || row.context !== JSON.stringify(context)) throw new Refused('PHONE_APPROVAL_USED', 'this grant was used, expired or names another action; request a fresh approval explicitly');
        db.prepare('UPDATE relay_action_grants SET used=1 WHERE hash=? AND used=0').run(hash(grant));
      });
      return principal;
    },
    /** Revoke only a current account's own board token after the native grant boundary consumed approval. */
    async revokeApprovedToken(principal, id, board) {
      const target = db.prepare("SELECT * FROM relay_credentials WHERE id=? AND kind='board' AND board=? AND user_id=?").get(id, board, principal.user.id);
      if (!target) throw new Refused('TOKEN_NOT_OWNED', 'choose an agent token id listed on this board');
      db.prepare('UPDATE relay_credentials SET revoked=1 WHERE id=?').run(id);
      return { id, revoked: true };
    },
    /** Revoke one owned credential; this never revokes an unrelated session or board token. */
    async revoke(token, id) {
      const row = credential(token);
      if (typeof id !== 'string') throw new Refused('TOKEN_NOT_OWNED', 'name one of your relay credentials to revoke');
      const target = db.prepare('SELECT id,user_id,kind,board FROM relay_credentials WHERE id=?').get(id);
      if (!target || target.user_id !== row.user_id || (row.kind !== 'session' && row.id !== id)) throw new Refused('TOKEN_NOT_OWNED', 'revoke only your own credential; sign in as its owner');
      if (target.kind === 'board') await auth.authenticate(token, { board: target.board, write: true });
      credential(token);
      db.prepare('UPDATE relay_credentials SET revoked=1 WHERE id=?').run(id);
      return { id, revoked: true };
    },
    /** Close persistent state and drop pending in-memory grants. */
    close() {
      if (closed) return;
      closed = true;
      webFlows.clear(); deviceFlows.clear(); deviceConfirmations.clear(); deviceSessionReceipts.clear(); sessionGuards.clear(); permissions.clear(); db.close();
    },
  };
  return auth;
}
