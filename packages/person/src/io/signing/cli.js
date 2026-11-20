import { relayFetch } from '../adapter.js';
/**
 * The terminal side of signed person moves [E22,B26,H16]: the passkey step a person-only command takes, the
 * `pullboard settings person.signed` switch, and pinning the relay's stamp key from this board's own relay origin.
 */
import * as store from "../../../../store/index.js";
import {
  attestAuthority,
  authorityAttested,
  authorityNeeded,
  offPending,
  passkeyConfirmed,
  personSigning,
  pinAuthority,
  signedMoveProblem,
  signedRefusal,
} from "../signing.js";
import { preparePersonRequest } from "../../logic/request.js";
import { personRequestRecords } from "../../logic/request.js";
import { Refused } from "../../../../kernel/index.js";
import { awaitPersonConfirmation } from "../confirmation.js";
import { loadMachineSettings } from "../../../../config/index.js";
import { repoInfo } from "../../../../git/index.js";
import { fileSystemAdapter } from "../../../../fs/index.js";
import { environmentAdapter } from "../../../../env/index.js";
import { join } from 'node:path';

const fs = fileSystemAdapter();

const AUTHORITY_PATH = '/.well-known/pullboard-person-authority';

/** The relay origin built into this code: the only place a board's first person authority is read from. */
/**
 * Whether a person authority may be read from this origin: the built-in relay over TLS, or the one origin an
 * in-process caller hands this command as `io.trustedRelayOrigin`. That parameter exists only in a caller's own call
 * path, never in pullboard.json, a board row, an environment variable or a global, so no shell can set it (#408).
 */
function authorityOrigin(origin, io, builtInOrigin) {
  if (origin === builtInOrigin) return environmentAdapter().get('NODE_TLS_REJECT_UNAUTHORIZED') !== '0';
  return typeof io?.trustedRelayOrigin === 'string' && io.trustedRelayOrigin === origin;
}

/** Require the actual native opener before a missing capability can enter a no-board catch. */
function personBoardOpener(ports) {
  if (typeof ports?.openBoard !== 'function') throw new TypeError('person signing requires its actual native board opener');
  return ports.openBoard;
}

/**
 * Read this board's person authority from its relay, every time a process needs one, even when the board already
 * pinned a key: a local row may have been written by anyone with the shell, so only the relay's answer counts. The
 * first answer is pinned; a local row that differs is ignored and reported by name. A relay that cannot be reached,
 * or an origin that is not the built-in relay, leaves the process without an authority, and passkey checks fail closed.
 *
 * @param {string} root
 * @param {any} board
 * @param {{ err?: (line: string) => void }} [io]
 * @param {{ DEFAULT_RELAY: string, relayStatus: (root: string) => any, timeoutMs?: number }} ports - the caller's relay capabilities
 * @returns {Promise<{ origin: string, publicKey: string } | null>}
 */
export async function pinRelayAuthority(root, board, io = {}, { timeoutMs = 10_000, DEFAULT_RELAY, relayStatus } = {}) {
  if (typeof DEFAULT_RELAY !== 'string' || typeof relayStatus !== 'function') throw new Refused('PERSON_AUTHORITY_PORT', 'the command caller must provide its relay authority ports');
  const builtInOrigin = new URL(DEFAULT_RELAY).origin;
  const relay = relayStatus(root);
  if (!relay.linked || !relay.url) return null;
  const origin = new URL(relay.url).origin;
  if (!authorityOrigin(origin, io, builtInOrigin)) {
    io.err?.(`pullboard: [PERSON_AUTHORITY_ORIGIN] ${origin} is not the built-in relay ${builtInOrigin} over TLS, so it cannot vouch for the person; person moves wait for the built-in relay`);
    return null;
  }
  let document;
  try {
    const response = await relayFetch(new URL(AUTHORITY_PATH, origin), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    document = await response.json();
    if (!response.ok) throw new Refused(document?.error?.code ?? 'PERSON_AUTHORITY', document?.error?.message ?? 'the relay refused');
  } catch (error) {
    io.err?.(`pullboard: [PERSON_AUTHORITY] could not read the passkey stamp key from ${origin} (${error.code ?? error.name ?? 'error'}); passkey-confirmed moves wait until it can`);
    return null;
  }
  const { attested, ignored } = attestAuthority(board, origin, document.authority);
  if (ignored) io.err?.(`pullboard: [PERSON_AUTHORITY_MISMATCH] this board's stored key for ${ignored.origin} does not match what ${origin} attests, so it is ignored; only the relay's key checks passkeys`);
  return attested;
}

/**
 * Before a command on a board that signs person moves, read the relay's authority once, so every strict check in this
 * process (signing state, passkey-confirmed rows and requests) sees the relay's answer. Other boards fetch nothing.
 *
 * @param {string} root
 * @param {{ err?: (line: string) => void }} io
 * @param {{ DEFAULT_RELAY: string, relayStatus: (root: string) => any, openBoardForRead?: (file: string) => any }} relayPorts
 */
export async function attestBeforeCommand(root, io, relayPorts) {
  const openBoard = personBoardOpener(relayPorts);
  const file = join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite');
  // Look first through a read-only connection: most commands need no vouching, and only pinning writes (#3206).
  if (typeof relayPorts.openBoardForRead === 'function') {
    let seen = null;
    try { seen = relayPorts.openBoardForRead(file); } catch { /* fall through to the writer, which reports its own refusal */ }
    if (seen) {
      let needed;
      try { needed = authorityNeeded(seen) && !authorityAttested(seen); } finally { store.closeBoard(seen); }
      if (!needed) return;
    }
  }
  let board;
  try { board = openBoard(file); }
  catch { return; } // No board here: nothing to vouch for, and the command reports its own refusal.
  // Budget: ceiling for one small read before a command; a slow relay leaves passkey checks failing closed instead.
  try { if (authorityNeeded(board) && !authorityAttested(board)) await pinRelayAuthority(root, board, io, { ...relayPorts, timeoutMs: 2_000 }); }
  finally { store.closeBoard(board); }
}

/**
 * The step a person-only command takes while signing is on. A command carrying out a passkey-confirmed request goes
 * ahead. Unpaired commands refuse at once with the pairing step. A linked command sends its exact supported move
 * to the passkey device and waits for one confirmation, reporting where; its caller then returns without a duplicate move.
 *
 * @returns {Promise<number | null>} Completed terminal exit code, or null when the original command may proceed.
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {{ verb: string, item?: number, args: any } | null} intent - the request the passkey device shows, or null when it cannot carry this move
 * @param {any[] | (() => any[])} [rows] - the rows the device shows, or a reader called only when a request is built
 */
export async function requireSignedPerson(ctx, board, me, intent, rows, effect) {
  if (!personSigning(board).signed) return null;
  const relayPorts = ctx.personPorts;
  if (typeof relayPorts?.relayStatus !== 'function' || typeof relayPorts?.ordered !== 'function') {
    throw new Refused('PERSON_AUTHORITY_PORT', 'the CLI caller must provide its relay and move-operation ports');
  }
  const relay = relayPorts.relayStatus(ctx.info.root);
  if (!relay.linked && !ctx.io.personRequest) throw signedRefusal('no passkey device is paired with this board');
  // Only the relay can vouch for a passkey stamp, including an off this board replayed: read its authority first.
  if (!authorityAttested(board) && !await pinRelayAuthority(ctx.info.root, board, ctx.io, relayPorts)) {
    throw signedRefusal('the relay could not vouch for your passkey, so a person move cannot be confirmed from here');
  }
  if (!personSigning(board).signed) return null;
  if (ctx.io.personRequest) {
    if (passkeyConfirmed(board, ctx.io.personRequest)) return null;
    throw signedRefusal('this request reached the board without a passkey confirmation', 'send it again from the relay view and confirm it with your passkey');
  }
  const origin = new URL(relay.url).origin;
  const where = `${origin}/#board=${relay.board}`;
  let sent = '';
  if (intent && me.id !== store.PERSON) {
    const request = preparePersonRequest(intent, undefined, typeof rows === 'function' ? rows() : rows, effect);
    try {
      await relayPorts.ordered(ctx, board, 'proposePersonMove', [{ agentId: me.id, request }]);
      sent = 'proposed';
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      sent = `; the request did not reach the relay (${error.code}), so start it there`;
    }
    if (sent === 'proposed') return awaitPersonConfirmation(ctx, board, request, where, relayPorts);
  }
  throw signedRefusal(`confirm it on your passkey${sent}`,
    `confirm it with your passkey at ${where} (Face ID, Touch ID or a key touch); keep the initiating terminal open while confirming. No passkey there yet? Add one on that page, or pair a new device with pullboard relay on --all`);
}

/**
 * Refuse, before ordering it, a person-only move that no passkey confirmed while the board signs person moves. Every
 * command's move passes here, so a person move a command does not ask about itself is still refused.
 *
 * @param {any} board
 * @param {string} operation
 * @param {any[]} args
 * @param {any} personRequest - the request the command carries out, if any
 */
export function refuseUnsignedMove(board, operation, args, personRequest) {
  const unsigned = signedMoveProblem(board, board.enginePorts.personAuthority({ operation, args }), personRequest, { strict: true });
  if (unsigned) throw unsigned;
}

/**
 * Whether the board of the checkout at `cwd` signs person moves, read without opening it for writing. Why the CLI
 * asks before parsing a person command: with signing on, a person move from any shell, SSH included, takes the
 * passkey step, so the shell-marker check that would otherwise stop it first gives way to that step.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function signsPersonMoves(cwd) {
  let file;
  try { file = join(repoInfo(cwd).commonDir, 'pullboard', 'board.sqlite'); }
  catch { return false; } // Outside a repository there is no board to sign for; the usual checks apply.
  if (!fs.exists(file)) return false;
  let db;
  try { db = store.openBoardReadOnly(file); return personSigning({ db }).signed; }
  catch { return false; } // An unreadable board keeps the stricter shell checks; the command then reports why it cannot open.
  finally { db?.close(); }
}

/**
 * Whether person moves on this board are signed, as the relay vouches for it: the read the command line uses to let
 * the passkey step stand in for the shell checks. Only an off after the last on needs the relay; then it is read
 * once, here, so a genuine off brings the shell checks back and a forged one leaves signing on (#408).
 *
 * @param {string} cwd
 * @param {{ err?: (line: string) => void }} io
 * @param {{ DEFAULT_RELAY: string, relayStatus: (root: string) => any }} relayPorts
 * @returns {Promise<boolean>}
 */
export async function personMovesSigned(cwd, io, relayPorts) {
  if (!signsPersonMoves(cwd)) return false;
  const openBoard = personBoardOpener(relayPorts);
  let board;
  try { board = openBoard(join(repoInfo(cwd).commonDir, 'pullboard', 'board.sqlite')); }
  catch { return true; } // Unreadable here: keep the passkey step, which refuses by name if it cannot go on.
  try {
    if (!offPending(board) || authorityAttested(board)) return personSigning(board).signed;
    // Budget: ceiling for one small read before a person command; an unreachable relay leaves signing on.
    await pinRelayAuthority(cwd, board, io, { ...relayPorts, timeoutMs: 2_000 });
    return personSigning(board).signed;
  } finally { store.closeBoard(board); }
}

export { signingLine } from "../../logic/signing/words.js";
import { signingLine } from "../../logic/signing/words.js";

/**
 * `pullboard settings person.signed on|off`. Anyone may turn signing on; off is a person move, so with signing on it
 * takes the passkey step like every other. The CLI caller supplies its board operation runner.
 */
export function signingSetting(io, value, { actOn }) {
  if (!['on', 'off'].includes(value)) throw new Refused('USAGE', 'pullboard settings person.signed on|off');
  return actOn(io, async (ctx, board, me) => {
    const signed = value === 'on';
    if (personSigning(board).signed === signed) {
      io.result?.({ settings: loadMachineSettings(), person: { signed } });
      io.say(`person moves are already ${signed ? '' : 'not '}signed`);
      return 0;
    }
    if (!signed) {
      const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'signing', args: { signed: value } });
      if (confirmed !== null) return confirmed;
    }
    else if (!await pinRelayAuthority(ctx.info.root, board, io, ctx.personPorts)) {
      throw new Refused('PERSON_SIGNING_RELAY', 'signed person moves need the built-in relay to vouch for your passkey, and it could not be reached from this board',
        'link this board to the relay with pullboard relay on --all, then turn signing on');
    }
    await ctx.personPorts.ordered(ctx, board, 'setPersonSigning', [signed ? { agentId: ctx.io.personRequest ? store.PERSON : me.id, signed }
      : { agentId: store.PERSON, signed, request: ctx.io.personRequest.id }]);
    io.result?.({ settings: loadMachineSettings(), person: { signed } });
    io.say(signingLine({ signed }));
    return 0;
  });
}

/**
 * Refuse a signed row decision on a row that names required SSH signers. Why by name: a passkey stands in for an
 * optional SSH sign-off, but a row that names its signers asked for those people's keys, and no passkey identity can
 * say which person it is yet.
 *
 * @param {{ id: string, signers?: string[] }[]} rows - the spec rows, and doctrine rows as `doctrine:<id>`
 * @param {string[]} ids - the rows being decided
 */
export function refuseNamedSigners(rows, ids) {
  const named = ids.map((id) => rows.find((row) => row.id === id)).filter((row) => row?.signers?.length);
  if (!named.length) return;
  throw new Refused('PERSON_SIGNER_REQUIRED', `${named.map((row) => `${row.id} names its SSH signers ${row.signers.join(', ')}`).join('; ')}, and a passkey cannot sign as a named signer yet`,
    'decide the other rows with your passkey; a row that names SSH signers waits until passkeys carry a signer identity, or until signing is off');
}

/**
 * Refuse a signed row decision unless the passkey-confirmed request names every decided row with the exact text the
 * person saw, and that text is still the row's. Why: the passkey confirms what was on the screen, so a row edited
 * after it was shown needs to be shown and decided again.
 *
 * @param {any} board
 * @param {any} personRequest - the request this command carries out
 * @param {{ id: string, text: string }[]} rows - the spec rows, and doctrine rows as `doctrine:<id>`
 * @param {string[]} ids - the rows being decided
 */
export function requireShownRows(board, personRequest, rows, ids, sources = []) {
  const record = personRequestRecords(board).find((entry) => entry.id === personRequest?.id && !entry.duplicateOf);
  const shown = record ? JSON.parse(record.encoded).rows : undefined;
  const changed = ids.filter((id) => !Array.isArray(shown) || shown.find((row) => row.id === id)?.text !== rows.find((row) => row.id === id)?.text
    || typeof shown.find(row => row.id === id)?.source !== 'string' || shown.find(row => row.id === id)?.source !== sources.find(row => row.id === id)?.source);
  if (changed.length) {
    throw new Refused('STALE_ROW_DECISION', `${changed.join(', ')} changed after the person saw ${changed.length === 1 ? 'it' : 'them'}, or the passkey request did not show ${changed.length === 1 ? 'it' : 'them'}`,
      'read the rows again in the relay view and decide them again with your passkey');
  }
}
