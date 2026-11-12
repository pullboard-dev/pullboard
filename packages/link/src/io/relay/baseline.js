import { formatSnapshotLimit } from '../../logic/relay/size.js';
import { clearUploadPauseNotices } from './pause.js';
import { firstUploadPauseNotice } from './pause.js';
import { safePauseMessage } from './pause.js';
import { Refused } from '../../../../kernel/light.js';
import { request } from '../relay.js';
import { localRecords } from '../relay.js';
import { saveLink } from './link.js';

const BASELINE_NOTICES = new WeakSet();
const BASELINE_ATTEMPTS = new WeakMap();
export const BASELINE_FAILURES = new WeakMap();

/** Name the safe next step for the saved permanent refusal. */
export function pauseFix(state) {
  const pause = state.baselinePause;
  if (pause.size || /(?:exceeds?|over|larger than|too large).{0,40}(?:bytes|snapshot|limit)|(?:snapshot|limit).{0,40}(?:exceeds?|over|too large)/iu.test(pause.message)) {
    return 'upgrade the configured relay to API version 2 for bounded snapshots, then it resumes automatically';
  }
  if ([401, 403].includes(pause.status) || pause.code === 'AUTH_REQUIRED') return 'run pullboard relay on to sign in again';
  return 'upgrade Pullboard or run pullboard relay on again, then report the refusal if it persists';
}

/** Render one bounded line with board, safe refusal reason and recovery step. */
export function baselinePauseLine(state) {
  const pause = state.baselinePause;
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(pause.code) ? pause.code : 'RELAY_REFUSED';
  const size = pause.size && Number.isSafeInteger(pause.size.sealedBytes) && Number.isSafeInteger(pause.size.limit)
    ? formatSnapshotLimit({ board: state.board, ...pause.size }, { paused: true }) : `relay paused for ${state.board} before its baseline upload`;
  return `pullboard: [${code}] ${size}: ${pause.message}; ${pauseFix(state)}`;
}

/** Report the durable pause once across preflight, move and postflight in one command. */
export function reportBaselinePause(state, io) {
  if (!BASELINE_NOTICES.has(io)) {
    BASELINE_NOTICES.add(io);
    if (firstUploadPauseNotice(state)) io.err(baselinePauseLine(state));
  }
}

/** Limit a paused board to one fresh baseline attempt within this command. */
export function attemptedBaselineThisCommand(io, file) {
  let attempts = BASELINE_ATTEMPTS.get(io);
  if (!attempts) { attempts = new Set(); BASELINE_ATTEMPTS.set(io, attempts); }
  if (attempts.has(file)) return true;
  attempts.add(file);
  return false;
}

/** Retain an uncertain attempt in RAM so preflight failure cannot permit local fallback in this command. */
export function rememberBaselineFailure(io, file, error) {
  let failures = BASELINE_FAILURES.get(io);
  if (!failures) { failures = new Map(); BASELINE_FAILURES.set(io, failures); }
  failures.set(file, error);
}

/** Confirm absence through authenticated API v1; a lost ACK or another live device must stay ordered. */
export async function remoteBaselineAbsent(state, io) {
  try { await request(state, '/api/v1/boards/' + state.board + '/state', {}, io); }
  catch (error) {
    if (await io.remoteBoardMissing(error)) return true;
    throw error;
  }
  return false;
}

/** Persist only a stable refusal code, never arbitrary relay text masquerading as a code. */
export function safePauseCode(error) {
  const code = error.relayCode ?? error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RELAY_REFUSED';
}

/** Keep a conflicting remote baseline fenced across process restarts without discarding local work. */
export function requireUnconflictedBaseline(state) {
  if (state.baselineConflict) throw new Refused('RELAY_BASELINE_EXISTS', 'the relay already holds this board; save the local board with pullboard export, then run pullboard relay off to keep working locally; local moves stay off to protect its ordered history');
}

/** Preserve the unaccepted local candidate and persist a refusal across process restarts. */
export function fenceBaseline(file, state) {
  state.baselineAccepted = true;
  state.baselineConflict = true;
  delete state.baselinePause;
  delete state.baselineUncertain;
  saveLink(file, state);
  requireUnconflictedBaseline(state);
}

/** Fence another device's baseline before a retry can replace its sequence-zero snapshot. */
export async function requireAbsentBaseline(file, state, io) {
  if (!await remoteBaselineAbsent(state, io)) {
    fenceBaseline(file, state);
  }
}

/** Record that the relay holds the pending sequence-zero snapshot, from its ACK or an authenticated read of it. */
export function acceptBaseline(root, file, state, io) {
  state.baselineAccepted = true;
  state.cursor = Number.isSafeInteger(state.baselineCursor) ? state.baselineCursor : localRecords(io.openBoard, root, (board) => board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
  delete state.baselineCursor;
  const resumed = Boolean(state.baselinePause);
  delete state.baselinePause;
  delete state.baselineStale;
  delete state.baselineUncertain;
  delete state.snapshot;
  state.presentationDigest = state.snapshotPresentationDigest ?? state.presentationDigest;
  delete state.snapshotPresentationDigest;
  state.needsPresentation = false;
  saveLink(file, state);
  if (resumed) clearUploadPauseNotices(state);
}

/** Decide a first upload whose reply was lost, through this link's transport and saved state (#919). */
export function decideBaseline(root, file, state, io) {
  return io.decideUncertainBaseline(state, io, { read: () => request(state, '/api/v1/boards/' + state.board + '/state', {}, io),
    accept: () => acceptBaseline(root, file, state, io), fence: () => fenceBaseline(file, state),
    save: () => saveLink(file, state), remember: (error) => rememberBaselineFailure(io, file, error) });
}

/**
 * Record that a local move happened while the baseline upload was uncertain, and say so once.
 * Why: the saved snapshot predates the move, so the next command seals a fresh baseline that holds it (#919).
 */
export function keepMoveForLaterBaseline(file, state, error, io) {
  state.baselineStale = true;
  saveLink(file, state);
  if (MOVE_FALLBACK_NOTICES.has(io)) return;
  MOVE_FALLBACK_NOTICES.add(io);
  io.err(`pullboard: [${safePauseCode(error)}] the move is saved on this machine; ${error.transportFailure ? `the relay did not answer (${error.transportFailure})` : safePauseMessage(error)}; it goes up inside the board baseline on a later command once the relay answers`);
}
