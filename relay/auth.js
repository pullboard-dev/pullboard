/** Hash-only relay sessions and board credentials, authorized by current GitHub roles [H8, H1, H13, H14, H16, H3]. */
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
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000; BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS relay_users (id TEXT PRIMARY KEY, login TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_boards (id TEXT PRIMARY KEY, repository TEXT NOT NULL, repository_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_cleanup (board TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS relay_credentials (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES relay_users(id), board TEXT REFERENCES relay_boards(id), agent TEXT, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    `);
    // Older unshipped links receive a full retention grace period, rather than guessing their age.
    if (!db.prepare('PRAGMA table_info(relay_boards)').all().some((column) => column.name === 'linked_at')) {
      db.exec('ALTER TABLE relay_boards ADD COLUMN linked_at INTEGER');
    }
    db.prepare('UPDATE relay_boards SET linked_at=? WHERE linked_at IS NULL').run(now());
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  const permissions = new Map();
  const webFlows = new Map();
  const deviceFlows = new Map();
  let closed = false;
  let locked = false;

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
      let repository;
      if (board !== undefined) {
        identifier(board, 'BAD_BOARD');
        repository = await access(row, board, write);
        if (board !== null && board !== undefined && !db.prepare('SELECT 1 FROM relay_boards WHERE id=?').get(board)) throw new Refused('BOARD_NOT_LINKED', 'link this board again before using it');
        credential(token); // A revocation or expiry during the awaited provider call must take effect.
      }
      return { id: row.id, kind: row.kind, user: { id: row.user_id, login: row.login }, ...(row.board ? { board: row.board, agent: row.agent } : {}), ...(repository ? { permission: repository.permission, public: repository.public } : {}), expires: row.expires };
    },
    /** Accept a link only from a signed-in human with current repository write access. */
    async linkBoard(token, board, repository) {
      identifier(board, 'BAD_BOARD');
      repositoryName(repository);
      const row = credential(token);
      if (row.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'sign in as a person to link a board');
      const repo = await github.access({ id: row.user_id, login: row.login }, repository);
      authorize({ allowed: true, hidden: false, role: repo.permission, public: repo.public }, {}, true);
      credential(token);
      open();
      lifecycle(() => {
        if (db.prepare('SELECT 1 FROM relay_cleanup WHERE board=?').get(board)) throw new Refused('RELAY_CLEANUP', 'finish pending board cleanup before linking again');
        const existing = db.prepare('SELECT * FROM relay_boards WHERE id=?').get(board);
        if (existing && existing.repository_id !== String(repo.id)) throw new Refused('BOARD_LINK_CONFLICT', 'use a new board identifier for a different repository');
        db.prepare('INSERT INTO relay_boards (id,repository,repository_id,linked_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository').run(board, repo.name, String(repo.id), now());
        permissions.delete(row.user_id + ':' + board);
      });
      return { id: board, repository: repo.name, repositoryID: String(repo.id) };
    },
    /** Internal maintenance inventory; HTTP callers must still pass the normal authorization boundary. */
    linkedBoards() {
      open();
      return db.prepare('SELECT id,repository,linked_at AS linkedAt FROM relay_boards ORDER BY id').all();
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
        db.prepare('DELETE FROM relay_credentials WHERE board=?').run(board);
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
    /** List only linked boards the current credential and GitHub account may read. */
    async boardsFor(token) {
      const row = credential(token);
      const boards = row.kind === 'board' ? db.prepare('SELECT * FROM relay_boards WHERE id=?').all(row.board) : db.prepare('SELECT * FROM relay_boards ORDER BY id').all();
      const visible = [];
      for (const board of boards) {
        try { await auth.authenticate(token, { board: board.id }); visible.push({ id: board.id, repository: board.repository, linkedAt: board.linked_at }); }
        catch (error) { if (!['NO_REPO_ACCESS', 'BOARD_NOT_LINKED'].includes(error.code)) throw error; }
      }
      return visible;
    },
    /** Keep the minimum replay engine at three after any agent token, including revoked or expired tokens. */
    minimumEngineVersion(board) {
      open();
      identifier(board, 'BAD_BOARD');
      return db.prepare("SELECT 1 FROM relay_credentials WHERE board=? AND kind='board' LIMIT 1").get(board) ? 3 : 1;
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
      webFlows.clear(); deviceFlows.clear(); permissions.clear(); db.close();
    },
  };
  return auth;
}
