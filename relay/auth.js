/** Hash-only relay sessions and board credentials, authorized by current GitHub metadata [H8, H1]. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../src/refused.js';
import { repositoryName } from './github.js';

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
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS relay_users (id TEXT PRIMARY KEY, login TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relay_boards (id TEXT PRIMARY KEY, repository TEXT NOT NULL, repository_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relay_credentials (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES relay_users(id), board TEXT REFERENCES relay_boards(id), agent TEXT, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
  `);
  const permissions = new Map();
  const webFlows = new Map();
  const deviceFlows = new Map();
  let closed = false;

  /** Refuse operation after closing instead of surfacing a raw SQLite error. */
  function open() { if (closed) throw new Refused('RELAY_CLOSED', 'start the relay before signing in or using a credential'); }

  /** Resolve a current credential and latest account login without storing its plaintext. */
  function credential(token) {
    open();
    if (typeof token !== 'string' || !/^(ps_|pa_)[A-Za-z0-9_-]{43}$/.test(token)) throw new Refused('AUTH_REQUIRED', 'sign in to the relay or supply a current board token');
    const row = db.prepare('SELECT c.*, u.login FROM relay_credentials c JOIN relay_users u ON u.id=c.user_id WHERE c.hash=?').get(hash(token));
    if (!row || row.revoked || row.expires <= now()) throw new Refused('AUTH_REQUIRED', 'this credential is expired or revoked; sign in or obtain a new board token');
    return row;
  }

  /** Mint one independently expiring/revocable credential and persist only its hash. */
  function issue(user, kind, board, agent, ttl) {
    open();
    const token = random(kind === 'session' ? 'ps_' : 'pa_');
    const id = randomUUID();
    const expires = now() + ttl;
    db.prepare('INSERT INTO relay_credentials (id,hash,kind,user_id,board,agent,expires) VALUES (?,?,?,?,?,?,?)').run(id, hash(token), kind, user.id, board ?? null, agent ?? null, expires);
    return { token, id, expires };
  }

  /** Learn the immutable GitHub identity, then drop the user access credential immediately. */
  async function signedIn(result) {
    if (!result || result.pending) throw new Refused('OAUTH_STATE', 'complete GitHub sign-in before creating a relay session');
    const user = await github.user(result.accessToken);
    open();
    if (!user || !/^[1-9][0-9]*$/.test(String(user.id)) || typeof user.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(user.login)) throw new Refused('GITHUB_AUTH', 'GitHub did not confirm your account; sign in again');
    db.prepare('INSERT INTO relay_users (id,login) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login').run(String(user.id), user.login);
    return { ...issue({ id: String(user.id) }, 'session', null, null, sessionTTL), user: { id: String(user.id), login: user.login } };
  }

  /** Remove expired in-memory flow secrets and limit anonymous sign-in allocations. */
  function pruneFlows() {
    open();
    for (const map of [webFlows, deviceFlows]) for (const [key, flow] of map) if (flow.expires <= now()) map.delete(key);
    if (webFlows.size + deviceFlows.size >= 10_000) throw new Refused('SIGN_IN_BUSY', 'too many sign-ins are pending; retry shortly');
  }

  /** Require GitHub-confirmed access, with a ten-minute read cache and a fresh check for writes. */
  async function access(row, board, write) {
    const linked = db.prepare('SELECT * FROM relay_boards WHERE id=?').get(board);
    if (!linked) throw new Refused('BOARD_NOT_LINKED', 'link this board to a readable GitHub repository before using it');
    const key = row.user_id + ':' + board;
    const prior = permissions.get(key);
    const started = now();
    if (!write && prior && started >= prior.checked && started - prior.checked < ACCESS_WINDOW_MS) {
      if (!prior.allowed) throw new Refused('NO_REPO_ACCESS', 'GitHub cannot confirm your repository access; ask for access and retry');
      return linked;
    }
    try {
      const repo = await github.access({ id: row.user_id, login: row.login }, linked.repository);
      if (String(repo.id) !== linked.repository_id) throw new Refused('NO_REPO_ACCESS', 'the linked repository identity changed; ask the coordinator to link the correct board');
      if (!permissions.has(key) || permissions.get(key).checked <= started) permissions.set(key, { checked: started, allowed: true });
      return linked;
    } catch (error) {
      if (error.code === 'NO_REPO_ACCESS' && (!permissions.has(key) || permissions.get(key).checked <= started)) permissions.set(key, { checked: started, allowed: false });
      throw error;
    }
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
    async beginDevice() {
      pruneFlows();
      const grant = await github.startDevice();
      pruneFlows();
      const ticket = random('pd_');
      deviceFlows.set(hash(ticket), { deviceCode: grant.deviceCode, expires: now() + grant.expiresIn * 1000, interval: grant.interval, next: now() + grant.interval * 1000 });
      return { ticket, userCode: grant.userCode, verificationURL: grant.verificationURL, expiresIn: grant.expiresIn, interval: grant.interval };
    },
    /** Throttle device polling, honor slow-down, and consume a successful grant only once. */
    async pollDevice(ticket) {
      open();
      if (typeof ticket !== 'string') throw new Refused('OAUTH_EXPIRED', 'start CLI sign-in again');
      const key = hash(ticket);
      const flow = deviceFlows.get(key);
      if (!flow || flow.expires <= now()) { deviceFlows.delete(key); throw new Refused('OAUTH_EXPIRED', 'CLI sign-in expired; start again'); }
      if (flow.busy || flow.next > now()) return { pending: true, retryAfter: Math.max(1, Math.ceil((flow.next - now()) / 1000)) };
      flow.next = now() + flow.interval * 1000;
      flow.busy = true;
      let result;
      try { result = await github.pollDevice(flow.deviceCode); }
      catch (error) { if (['OAUTH_DENIED', 'OAUTH_EXPIRED'].includes(error.code)) deviceFlows.delete(key); throw error; }
      finally { flow.busy = false; }
      if (flow.expires <= now()) { deviceFlows.delete(key); throw new Refused('OAUTH_EXPIRED', 'CLI sign-in expired; start again'); }
      if (result.pending) {
        if (result.slow) flow.interval += 5;
        if (Number.isFinite(result.interval) && result.interval > flow.interval) flow.interval = result.interval;
        flow.next = now() + flow.interval * 1000;
        return { pending: true, retryAfter: flow.interval };
      }
      deviceFlows.delete(key);
      return signedIn(result);
    },
    /** Authenticate a human or a scoped agent; every board write asks GitHub again. */
    async authenticate(token, { board, write = false } = {}) {
      const row = credential(token);
      if (row.kind === 'board' && board !== row.board) throw new Refused('TOKEN_BOARD', 'use this token only on its named board; obtain another token for another board');
      if (board !== undefined) {
        identifier(board, 'BAD_BOARD');
        await access(row, board, write);
        credential(token); // A revocation or expiry during the awaited provider call must take effect.
      }
      return { id: row.id, kind: row.kind, user: { id: row.user_id, login: row.login }, ...(row.board ? { board: row.board, agent: row.agent } : {}), expires: row.expires };
    },
    /** Accept a link only from a signed-in human with current repository read access. */
    async linkBoard(token, board, repository) {
      identifier(board, 'BAD_BOARD');
      repositoryName(repository);
      const row = credential(token);
      if (row.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'sign in as a person to link a board');
      const repo = await github.access({ id: row.user_id, login: row.login }, repository);
      credential(token);
      open();
      const existing = db.prepare('SELECT * FROM relay_boards WHERE id=?').get(board);
      if (existing && existing.repository_id !== String(repo.id)) throw new Refused('BOARD_LINK_CONFLICT', 'use a new board identifier for a different repository');
      db.prepare('INSERT INTO relay_boards (id,repository,repository_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository').run(board, repo.name, String(repo.id));
      permissions.delete(row.user_id + ':' + board);
      return { id: board, repository: repo.name, repositoryID: String(repo.id) };
    },
    /** List only linked boards the current credential and GitHub account may read. */
    async boardsFor(token) {
      const row = credential(token);
      const boards = row.kind === 'board' ? db.prepare('SELECT * FROM relay_boards WHERE id=?').all(row.board) : db.prepare('SELECT * FROM relay_boards ORDER BY id').all();
      const visible = [];
      for (const board of boards) {
        try { await auth.authenticate(token, { board: board.id }); visible.push({ id: board.id, repository: board.repository }); }
        catch (error) { if (error.code !== 'NO_REPO_ACCESS') throw error; }
      }
      return visible;
    },
    /** Mint an agent credential scoped to a single readable board and immutable human identity. */
    async issueToken(token, { board, agent, expiresIn = tokenTTL }) {
      identifier(board, 'BAD_BOARD');
      identifier(agent, 'BAD_AGENT');
      if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_TTL) throw new Refused('BAD_EXPIRY', 'choose a token expiry between one millisecond and thirty days');
      const principal = await auth.authenticate(token, { board, write: true });
      if (principal.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'sign in as a person to issue a board token');
      credential(token);
      return { ...issue(principal.user, 'board', board, agent, expiresIn), board, agent };
    },
    /** Revoke one owned credential; this never revokes an unrelated session or board token. */
    revoke(token, id) {
      const row = credential(token);
      if (typeof id !== 'string') throw new Refused('TOKEN_NOT_OWNED', 'name one of your relay credentials to revoke');
      const target = db.prepare('SELECT id,user_id FROM relay_credentials WHERE id=?').get(id);
      if (!target || target.user_id !== row.user_id || (row.kind !== 'session' && row.id !== id)) throw new Refused('TOKEN_NOT_OWNED', 'revoke only your own credential; sign in as its owner');
      db.prepare('UPDATE relay_credentials SET revoked=1 WHERE id=?').run(id);
      return { id, revoked: true };
    },
    /** Close persistent state and drop pending in-memory grants. */
    close() {
      if (closed) return;
      closed = true;
      webFlows.clear(); deviceFlows.clear(); permissions.clear(); db.close();
    },
  };
  return auth;
}
