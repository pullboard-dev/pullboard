/**
 * Signed person moves [E22,B26,H16]. A board can require that every person-only move (answering a person decision,
 * deciding a spec or doctrine row, waiving a test, turning signing off) is confirmed on a passkey the person
 * registered on the relay with user presence. Why a passkey and not a key on disk: any key the user's shell can use,
 * an agent in that shell can use too, while an authenticator signs only with a person present.
 *
 * The policy is read from the board's append-only event log, never from a row an edit can change, and turning it
 * off counts only with the relay's signed passkey stamp, checked against the relay key this board pinned itself.
 */
import {
  atomic,
  logEvent,
  PERSON,
  SIGNED_EVENT_LOG_VERSION,
} from "../../../store/index.js";
import { createHash } from 'node:crypto';
import { Refused } from "../../../kernel/index.js";
import { validatePersonRequest } from "../logic/request.js";
import { personRequestRecords } from "../logic/request.js";
import { requestIntentDigest } from "./digest.js";
import { validPresence } from "./presence.js";
import { presenceSigned } from "./presence.js";
import {
  attestedAuthority,
  rememberAttested,
} from "../logic/attested.js";

import { boardStanding } from "../../../store/index.js";
import { recordSchemaStamp } from "../../../store/index.js";
import { SCHEMA_DIGEST } from "../../../store/index.js";
import { SCHEMA_VERSION } from "../../../store/index.js";

import { AUTHORITY } from "../../../store/index.js";
import { AUTHORITY_TRIGGERS } from "../../../store/index.js";

const PROPOSALS = 'person_proposals';
const PROPOSAL_MS = 10 * 60_000;
const KEPT_PROPOSALS = 50;

/** Write one board metadata value inside the caller's transaction. */
function meta(board, key, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, value);
}

/** Read one JSON board metadata value, or a fallback when it was never written. */
function read(board, key, fallback) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.meta_value); }
  catch { throw new Refused('PERSON_SIGNING_CORRUPT', `the board's ${key} record is unreadable; restore the board from a known-good export`); }
}

/** This board's id, which every passkey stamp names. */
function boardId(board) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('board_id')?.meta_value ?? null;
}

/**
 * The relay key this board pinned from its own configured relay origin, or null before it first reached one.
 *
 * @param {any} board
 * @returns {{ origin: string, publicKey: string } | null}
 */
export function localAuthority(board) {
  return read(board, AUTHORITY, null);
}

/** The authority a relay published, checked for shape; refused when it names no usable stamp key. */
function validAuthority(origin, authority) {
  if (authority?.version !== 1 || authority.algorithm !== 'Ed25519' || typeof authority.publicKey !== 'string' || !/^[A-Za-z0-9_-]{40,200}$/u.test(authority.publicKey)) {
    throw new Refused('PERSON_AUTHORITY', `the relay at ${origin} published no usable passkey stamp key; upgrade the relay and retry`);
  }
  return { origin, publicKey: authority.publicKey };
}

/**
 * Pin the relay's public stamp key, once. A later different key, or the same key from another origin, is refused:
 * nothing replaces the first pin, so a key written in by hand later never verifies a stamp.
 *
 * @param {any} board
 * @param {string} origin - the relay origin this board is linked to
 * @param {any} authority - the relay's published `{version: 1, algorithm: 'Ed25519', publicKey}`
 */
export function pinAuthority(board, origin, authority) {
  validAuthority(origin, authority);
  return atomic(board, () => {
    const existing = localAuthority(board);
    if (existing) {
      if (existing.origin === origin && existing.publicKey === authority.publicKey) return existing;
      throw new Refused('PERSON_AUTHORITY_CHANGED', `this board pinned the relay key of ${existing.origin}, and ${origin} now presents another; check which relay this board belongs to before linking it there`);
    }
    const current = boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION) === 'current';
    const pinned = { origin, publicKey: authority.publicKey };
    meta(board, AUTHORITY, JSON.stringify(pinned));
    for (const { sql } of AUTHORITY_TRIGGERS) board.db.exec(sql);
    if (current) recordSchemaStamp(board.db, SCHEMA_DIGEST);
    return pinned;
  });
}

/**
 * Whether a passkey stamp is genuine: syntactically whole and, when `strict`, signed for this board under the pinned
 * relay key. Without a pin a strict check fails closed.
 */
function stampHolds(board, stamp, strict) {
  if (!validPresence(stamp)) return false;
  if (!strict) return true;
  const attested = attestedAuthority(boardId(board));
  return Boolean(attested) && stamp.board === boardId(board) && presenceSigned(stamp, attested.publicKey);
}

/**
 * Record the authority this process fetched from the relay, and pin it as the board's first pin when none exists.
 * A local row that differs is ignored, never trusted and never replaced (its triggers keep it), and is returned so
 * the caller reports it by name.
 *
 * @param {any} board
 * @param {string} origin - the built-in relay origin the authority was read from over TLS
 * @param {any} authority - the relay's published `{version: 1, algorithm: 'Ed25519', publicKey}`
 * @returns {{ attested: { origin: string, publicKey: string }, ignored: { origin: string, publicKey: string } | null }}
 */
export function attestAuthority(board, origin, authority) {
  const local = localAuthority(board);
  const attested = local && local.origin === origin && local.publicKey === authority?.publicKey
    ? local : local ? validAuthority(origin, authority) : pinAuthority(board, origin, authority);
  rememberAttested(boardId(board), attested);
  return { attested, ignored: attested === local || !local ? null : local };
}

/** Whether this process holds a relay-attested authority for the board. */
export function authorityAttested(board) {
  return Boolean(attestedAuthority(boardId(board)));
}

/**
 * Whether this board's strict reading of person moves depends on the relay's authority: it has ever signed person
 * moves, so its signing state and every passkey-confirmed row or request can only be checked against the relay.
 * A board that never signed fetches nothing.
 */
export function authorityNeeded(board) {
  return Boolean(board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'person_signing' LIMIT 1").get());
}

/** Whether an off comes after the last on: the board reads as signed only until the relay vouches for that off. */
export function offPending(board) {
  const rows = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'person_signing' ORDER BY event_id DESC").all();
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.event_detail); } catch { continue; }
    if (detail?.signed === true) return false;
    if (detail?.signed === false) return true;
  }
  return false;
}

/**
 * Whether person moves on this board must be confirmed on a passkey: the latest `person_signing` event that counts.
 * Anyone may turn signing on; an off counts only from the person with a passkey stamp, which `strict` also checks
 * against the pinned relay key. Commands use the strict reading, so an off written into the event log by hand
 * leaves signing on; replay uses the replicated reading, so every replica reaches the same state.
 *
 * @param {any} board
 * @param {{ strict?: boolean }} [options]
 * @returns {{ signed: boolean, by?: string, at?: string }}
 */
export function personSigning(board, { strict = true } = {}) {
  let state = { signed: false };
  const consumed = new Set();
  for (const row of board.db.prepare("SELECT event_by, event_at, event_detail FROM event WHERE event_kind = 'person_signing' ORDER BY event_id").all()) {
    let detail;
    try { detail = JSON.parse(row.event_detail); }
    catch { continue; } // An unreadable record turns nothing off; an on before it still holds.
    if (detail?.signed === true) state = { signed: true, by: row.event_by, at: row.event_at };
    else if (detail?.signed === false && row.event_by === PERSON && !consumed.has(detail.request) && offIntent(detail) && stampHolds(board, detail.presence, strict)) {
      consumed.add(detail.request);
      state = { signed: false, by: PERSON, at: row.event_at };
    }
  }
  return state;
}

/**
 * Whether an off event carries the very request a passkey confirmed: a request to turn signing off, whose exact
 * JSON the stamp's digest names. Why the event keeps the request itself: a stamp for some other request, copied into
 * a hand-written off, then names a different digest and turns nothing off.
 */
function offIntent(detail) {
  const intent = detail.intent;
  return Boolean(intent && intent.id === detail.request && detail.presence?.request === detail.request && intent.move?.verb === 'signing'
    && intent.move.args?.signed === 'off' && createHash('sha256').update(JSON.stringify(intent)).digest('hex') === detail.presence.digest);
}

/** Raise a board's event-log format once it has signed person moves, so an older Pullboard cannot open it. */
export function stampSigningFormat(db) {
  if (!db.prepare("SELECT 1 FROM event WHERE event_kind = 'person_signing' LIMIT 1").get()) return;
  db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('event_log_version', String(SIGNED_EVENT_LOG_VERSION));
}

/**
 * Turn signing on or off as one ordered move. Anyone may turn it on. Only the person turns it off, carrying out a
 * passkey-confirmed request whose relay stamp the event keeps, so every reader can check it.
 *
 * @param {any} board
 * @param {{ agentId: string, signed: boolean, request?: string }} options
 */
export function setPersonSigning(board, { agentId, signed, request }) {
  if (typeof agentId !== 'string' || !agentId || typeof signed !== 'boolean') throw new Refused('USAGE', 'pullboard settings person.signed on|off');
  const presence = signed ? null : requestPresence(board, request, { strict: false });
  const record = presence && personRequestRecords(board).find((entry) => entry.id === request && !entry.duplicateOf);
  const detail = presence ? { signed, request, presence, intent: JSON.parse(record.encoded) } : { signed };
  if (!signed && (agentId !== PERSON || !presence || !offIntent(detail))) throw signedRefusal('only the person turns signing off, on their passkey');
  return atomic(board, () => {
    const current = boardStanding(board.db, SCHEMA_DIGEST, SCHEMA_VERSION) === 'current';
    logEvent(board, agentId, 'person_signing', null, detail);
    stampSigningFormat(board.db);
    if (current) recordSchemaStamp(board.db, SCHEMA_DIGEST);
    return { signed, by: agentId };
  });
}

/** The person moves waiting for a passkey, oldest first, each with the exact request the passkey confirms. */
export function personProposals(board) {
  return read(board, PROPOSALS, []);
}

/**
 * Record a person move started in a terminal as a request the person's passkey device shows, so it completes on one
 * confirmation there. It grants nothing: the device sends the same request, and only a passkey makes it count.
 *
 * @param {any} board
 * @param {{ agentId: string, request: any }} options
 */
export function proposePersonMove(board, { agentId, request }) {
  if (typeof agentId !== 'string' || !agentId || agentId === PERSON) throw new Refused('PERSON_PROPOSAL', 'a terminal proposes a person move for the person to confirm on their passkey');
  const document = validatePersonRequest(request);
  return atomic(board, () => {
    const at = board.clock.now();
    const entry = { id: document.id, move: document.move, ...(document.rows ? { rows: document.rows } : {}), ...(document.effect ? { effect: document.effect } : {}), by: agentId, at: at.toISOString(), expires: new Date(at.getTime() + PROPOSAL_MS).toISOString() };
    const kept = personProposals(board).filter((proposal) => proposal.id !== document.id);
    meta(board, PROPOSALS, JSON.stringify([...kept, entry].slice(-KEPT_PROPOSALS)));
    logEvent(board, agentId, 'person_proposal', null, { request: document.id, verb: document.move.verb });
    return entry;
  });
}

/**
 * The relay's passkey stamp on a recorded person request, or null. It counts only when it names this request and
 * the digest of its exact intent, and, when `strict`, carries the relay's signature under the pinned key.
 *
 * @param {any} board
 * @param {string} id
 * @param {{ strict?: boolean }} [options]
 */
export function requestPresence(board, id, { strict = true } = {}) {
  const record = personRequestRecords(board).find((entry) => entry.id === id && !entry.duplicateOf);
  if (!record) return null;
  let received;
  try { received = JSON.parse(record.received); }
  catch { return null; } // A receipt without readable provenance carries no presence; the gates refuse it.
  const presence = received?.sender?.presence;
  // The stamp names the digest of the request as received; the move the board carries out must be that request's.
  const bound = JSON.stringify(received.document) === record.encoded && JSON.stringify(received.document?.move) === JSON.stringify(record.move);
  return received?.sender?.kind === 'person' && bound && presence?.request === record.id && presence.digest === requestIntentDigest(record)
    && stampHolds(board, presence, strict) ? presence : null;
}

export { verifiedPasskeyRowDecision } from "./proof.js";

/** Whether this command or move carries out a person request a passkey confirmed. */
export function passkeyConfirmed(board, personRequest, { strict = true } = {}) {
  return personRequest?.phase === 'execute' && typeof personRequest.id === 'string' && Boolean(requestPresence(board, personRequest.id, { strict }));
}

/** The refusal every unsigned person move gets while signing is on, naming where the passkey step happens. */
export function signedRefusal(message, next = 'pair your phone or a computer browser with pullboard relay on --all, add a passkey there, then confirm person moves on it') {
  return new Refused('PERSON_SIGNED', `person moves on this board are signed with your passkey: ${message}`, next);
}

/**
 * Refuse a person-only move while signing is on unless it carries out a passkey-confirmed request. Commands check it
 * strictly before ordering a move; every replica checks it again on replay with the replicated reading.
 *
 * A request's claim, refusal and coordinator-request receipts are fixed-text shouts the request binds (see
 * requestMoveProblem), not person decisions, so they pass; the move that carries the request out needs the passkey.
 *
 * @param {any} board
 * @param {boolean} personOnly - whether the move is one only the person makes
 * @param {any} personRequest - the verified request receipt the move carries out, if any
 * @param {{ strict?: boolean }} [options]
 * @returns {Refused | null}
 */
export function signedMoveProblem(board, personOnly, personRequest, { strict = false } = {}) {
  if (!personOnly || !personSigning(board, { strict }).signed) return null;
  if (['claim', 'refuse', 'repo-request'].includes(personRequest?.phase) || passkeyConfirmed(board, personRequest, { strict })) return null;
  return signedRefusal('no passkey confirmed this move');
}

/**
 * Restore a checkpoint or import without losing what this board alone knows: the pinned relay key never comes from
 * a document and survives a restore, and a board that had signing on refuses a restore that turns it off without a
 * stamped off. Returns the function to run once the rows are in, before the restore commits.
 *
 * @param {any} db - the board's database, inside the restore transaction
 * @param {any} document - the export or checkpoint being restored, whose own pin row is dropped
 */
export function guardRestore(db, document) {
  const board = { db };
  const pinned = localAuthority(board);
  const wasSigned = personSigning(board).signed;
  if (Array.isArray(document?.tables?.board_meta)) document.tables.board_meta = document.tables.board_meta.filter((row) => row.meta_key !== AUTHORITY);
  for (const { name } of AUTHORITY_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  return () => {
    if (pinned) {
      meta(board, AUTHORITY, JSON.stringify(pinned));
      for (const { sql } of AUTHORITY_TRIGGERS) db.exec(sql);
    }
    stampSigningFormat(db);
    if (wasSigned && !personSigning(board).signed) {
      throw new Refused('PERSON_SIGNING_ERASED', 'this board signs person moves, and the checkpoint or import turns that off without the passkey; restore a known-good board instead');
    }
  };
}

/** The store's export filter stays the one source a raw {db} export and the native root share [E22]. */
export { exportedMeta } from "../../../store/index.js";
