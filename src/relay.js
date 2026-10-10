/** Opt-in, sealed relay ordering, with crash-safe migration from the older mirror [H1,H3,H5,H16,H17,P5]. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import * as store from './board.js';
import { exportBoard, importBoard, restoreRelaySnapshot, semanticBoardDigest } from './exchange.js';
import { appliedSequence, applyRelayMove, checkpointSequence, engineReceipt, prepareEngineMove, refuseRelayMove, requireSupportedEngine, startRelayEpoch } from './engine.js';
import { relayMoveActor } from './relay-sender.js';
import { ENGINE_VERSION } from './machine.js';
import { presentationDigest, relayPresentation, relaySnapshot } from './relay-presentation.js';
import { repoInfo, tryGit } from './git.js';
import { forgetBoardKey, readBoardKey, storeBoardKey } from './relay-key.js';
import { encodeBoardKey, generateBoardKey, seal, unseal } from './seal.js';
import { terminalQr } from './qr.js';
import { Refused } from './refused.js';
import { relaySenderProblem } from './relay-sender.js';
import { readRelayMachine, removeRecordedDevice, updateRelayMachine, wrapForRecordedDevice } from './relay-machine.js';
import { receivePersonRequest, requestMoveProblem } from './relay-requests.js';
import { nativePhoneAction, phoneProposal, publishPhoneApproval, warnPhoneApproval } from './relay-phone.js';
import { requirePersonChannel } from './person.js';
import { listApiProjects } from './projects.js';

export const DEFAULT_RELAY = 'https://app.pullboard.dev';
const SEALED_SNAPSHOT_LIMIT = 10_000_000;
const LINK_FILES = new WeakMap();
const WARNED_COMMANDS = new WeakSet();
const KEY_WARNED_COMMANDS = new WeakSet();
const BASELINE_ATTEMPTS = new WeakMap();
const BASELINE_NOTICES = new WeakSet();
const CHECKPOINT_NOTICES = new WeakMap();
const CHECKPOINT_MOVES = new WeakMap();
const BASELINE_LOCAL_MOVES = new WeakSet();
const BASELINE_FAILURES = new WeakMap();
const AUTH_NOTICES = new WeakSet();
const ORDERED_MOVE_COMMANDS = new Set(['add', 'edit', 'fact', 'escalate', 'run', 'sweep', 'next', 'claim', 'hold', 'release',
  'submit', 'done', 'verify', 'merged', 'land', 'withdraw', 'refreeze', 'shout', 'answer', 'pass', 'import', 'milestone', 'takeover', 'forget', 'join', 'worktree']);

/** Require a trusted origin; HTTP exists only for loopback development and test relays. */
export function relayOrigin(address) {
  let url;
  try { url = new URL(address); } catch { throw new Refused('RELAY_URL', 'use an HTTPS relay address, such as https://app.pullboard.dev'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Refused('RELAY_URL', 'use an HTTPS origin without credentials, a path, query or fragment; loopback HTTP is allowed for a local relay');
  }
  return url.origin;
}

/** Resolve the GitHub owner/repository named by the actual origin remote, never a guessed repo. */
export function originRepository(root) {
  const remote = tryGit(root, ['remote', 'get-url', 'origin']);
  if (remote.status !== 0) throw new Refused('RELAY_ORIGIN', 'add a GitHub origin remote before running pullboard relay on');
  let repository;
  const ssh = /^git@github\.com:([^\s?#]+)$/.exec(remote.stdout);
  if (ssh) repository = ssh[1];
  else {
    try {
      const url = new URL(remote.stdout);
      if (url.hostname === 'github.com' && !url.password && !url.search && !url.hash &&
          ((url.protocol === 'https:' && !url.username) || (url.protocol === 'ssh:' && url.username === 'git')) && !url.port) repository = url.pathname.slice(1);
    } catch { /* A local path or another host is not a GitHub repository. */ }
  }
  repository = repository?.replace(/\.git$/, '');
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some((part) => ['.', '..'].includes(part))) {
    throw new Refused('RELAY_ORIGIN', 'origin must name a GitHub owner/repository using HTTPS or git SSH; fix origin and run pullboard relay on');
  }
  return repository;
}

/** Find the shared local link metadata without opening a board or connecting for an unlinked repo. */
function linkFile(root) { return join(repoInfo(root).commonDir, 'pullboard', 'relay.json'); }

/** Validate private link metadata before trusting its destination or acknowledgement cursor. */
function loadLink(file) {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_STORAGE', 'restore relay.json as an owner-only regular file with mode 600');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Refused('RELAY_STORAGE', 'restore valid relay link metadata before syncing this board'); }
  if (!state || typeof state !== 'object' || state.version !== 1 || !/^[0-9a-f]{32}$/.test(state.board) || !(state.token === undefined || state.personReauth && state.token === null || /^(ps_|pa_|pm_)[A-Za-z0-9_-]{43}$/.test(state.token)) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Refused('RELAY_STORAGE', 'restore supported relay link metadata before syncing this board');
  }
  relayOrigin(state.url);
  if (state.token === undefined || state.token?.startsWith('ps_')) {
    state.token = null;
    delete state.tokenId;
    state.personReauth = true;
    saveLink(file, state);
  }
  return state;
}

/** Atomically persist acknowledgements and an exact sealed retry before attempting its send. */
function saveLink(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Wait briefly for another worktree's upload, recovering a lock only when its owner is gone. */
async function locked(file, work) {
  const lock = file + '.lock';
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 15000;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'pid'), String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (dead) { if (dead.code === 'ESRCH') { rmSync(lock, { recursive: true, force: true }); continue; } }
        }
      } catch {
        try { if (Date.now() - lstatSync(lock).mtimeMs > 30000) { rmSync(lock, { recursive: true, force: true }); continue; } }
        catch (gone) { if (gone.code === 'ENOENT') continue; throw gone; }
      }
      if (Date.now() >= deadline) throw new Refused('RELAY_BUSY', 'another worktree is sending this board; the local move is safe and the next command retries');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    // Only the current lock holder can have a live link write; remove crashed legacy bearer fragments.
    for (const name of readdirSync(dirname(file))) {
      if (/^relay\.json\.[0-9a-f-]+\.tmp$/u.test(name)) rmSync(join(dirname(file), name), { force: true });
    }
    return await work();
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Surface retention notices on the very command that receives them, without exposing credentials. */
function notices(document, io) {
  const warnings = [document.warning, document.state?.warning, ...(document.warnings ?? [])].filter(Boolean);
  for (const warning of warnings) if (warning.code === 'BOARD_INACTIVE' && !WARNED_COMMANDS.has(io)) {
    WARNED_COMMANDS.add(io);
    io.err(`pullboard: [BOARD_INACTIVE] ${warning.daysLeft} days left before this relay board is deleted; ${warning.next || 'make a board move before the deadline to keep it'}`);
  }
}

/** The sole outbound transport in the CLI: explicit sign-in or a saved, opted-in board link. */
async function request(state, path, { method = 'GET', body, allowMissing = false, initialBaseline = false } = {}, io) {
  const supplied = process.env.PULLBOARD_RELAY_TOKEN;
  const readToken = method === 'GET' && path.startsWith('/api/v1/boards/') ? supplied : undefined;
  if (readToken !== undefined && !/^pa_[A-Za-z0-9_-]{43}$/.test(readToken)) throw new Refused('AUTH_REQUIRED', 'supply a current scoped board token without including it in command arguments');
  const token = readToken ?? state.token;
  let response;
  try {
    response = await fetch(relayOrigin(state.url) + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'x-pullboard-engine': String(ENGINE_VERSION), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(initialBaseline ? { 'if-none-match': '*' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Refused('RELAY_UNAVAILABLE', `the relay ${state.url} did not answer; read the local board offline, then retry this move when the relay is reachable`); }
  let document;
  try { document = await response.json(); }
  catch {
    const error = new Refused('RELAY_RESPONSE', 'the relay returned an invalid response; retry with the configured relay address');
    error.httpStatus = response.status;
    throw error;
  }
  notices(document, io);
  // Only off can forget a link after a supported API reports that the board is gone.
  if (allowMissing && method === 'DELETE' && response.status === 404 && document.version === 1) return { alreadyDeleted: true };
  if (!response.ok) {
    const error = new Refused(document.error?.code || 'RELAY_UNAVAILABLE', (document.error?.code === 'AUTH_REQUIRED' ? ((state.agent || token?.startsWith('pa_')) ? 'this agent token is expired or revoked; use a new token issued by the person for this agent, then retry with PULLBOARD_RELAY_TOKEN' : 'the relay sign-in expired or was revoked; run pullboard relay on to sign in again without changing the board key') : (document.error?.message ? `the relay ${state.url}: ${document.error.message}` : null)) || 'the relay refused this send; retry this command explicitly when reachable');
    error.httpStatus = response.status;
    error.relayVersion = document.version;
    error.relayCode = document.error?.code;
    error.relayMessage = document.error?.message;
    throw error;
  }
  if (document.version !== 1) throw new Refused('RELAY_VERSION', 'the relay API version is unsupported; upgrade Pullboard before syncing');
  return document;
}

/** Read durable local event rows; their ids are the crash-safe outbox after the saved cursor. */
function localRecords(root, work) {
  const info = repoInfo(root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Fingerprint native board contents so async recovery can refuse concurrent local writes. */
function nativeBoardDigest(board) {
  return semanticBoardDigest(exportBoard(board));
}

/** Confirm a recovered checkpoint contains the same durable refusal for the blocked transport slot. */
function recoveryRefusalMatches(document, recovery) {
  const boardMeta = Array.isArray(document?.tables?.board_meta) ? document.tables.board_meta : [];
  const events = Array.isArray(document?.tables?.event) ? document.tables.event : [];
  const meta = boardMeta.find((row) => row?.meta_key === 'relay_refusal_' + recovery.skip);
  if (!meta || typeof meta.meta_value !== 'string') return false;
  let refusal;
  try { refusal = JSON.parse(meta.meta_value); } catch { return false; }
  if (typeof refusal?.outcome?.error?.code !== 'string' ||
      (recovery.blockerDigest && refusal.record !== recovery.blockerDigest)) return false;
  return events.some((event) => {
    if (event?.event_kind !== 'relay_refused' || typeof event.event_detail !== 'string') return false;
    try {
      const detail = JSON.parse(event.event_detail);
      return detail.sequence === recovery.skip && detail.code === refusal.outcome.error.code;
    } catch { return false; }
  });
}

/** Count unapplied uploads using durable event ids, without counting relay transport metadata. */
function behind(root, state) {
  return localRecords(root, (board) => board.db.prepare('SELECT COUNT(*) AS count FROM event WHERE event_id > ?').get(state.cursor).count);
}

/** Expose only the actionable recovery choice; checkpoint ciphertext and local digests stay private. */
function recoverySummary(state) {
  const skip = Number.isSafeInteger(state?.recovery?.skip) ? state.recovery.skip : 0;
  return { pending: skip > 0, skip, next: skip > 0 ? `pullboard relay recover --skip ${skip}` : '' };
}

/** Expose key-free link status; only an explicit link operation includes its pairing carrier. */
function summary(root, state, { pairing = false } = {}) {
  if (!state) return { linked: false, board: '', url: '', link: '', sequence: 0, behind: 0, recovery: recoverySummary(null) };
  if (state.unlinking) return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0, cleanup: true, recovery: recoverySummary(state) };
  const fragment = pairing ? '&key=' + encodeBoardKey(readBoardKey(state.board)) : '';
  const oversizedSnapshot = snapshotSize(state);
  return { linked: true, board: state.board, url: state.url,
    link: 'https://app.pullboard.dev/#board=' + state.board + fragment,
    sequence: state.sequence, behind: (state.baselinePause ? behind(root, state) : state.mode === 'ordered' ? Number(Boolean(state.pending)) : behind(root, state)) + Number(Boolean(state.snapshot || state.checkpoint)),
    recovery: recoverySummary(state),
    ...(oversizedSnapshot ? { oversizedSnapshot } : {}),
    ...(state.baselinePause ? { pausedUpload: structuredClone(state.baselinePause) } : {}),
    ...(state.checkpointRefusal ? { refusedCheckpoint: checkpointProblem(state) } : {}) };
}

/** Measure a pending sealed snapshot against the relay's decoded journal limit. */
function snapshotSize(state) {
  const sealed = state?.snapshot?.sealed ?? state?.checkpoint?.sealed;
  if (typeof sealed !== 'string') return null;
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.toString('base64url') !== sealed || bytes.byteLength <= SEALED_SNAPSHOT_LIMIT) return null;
  return { board: state.board, sealedBytes: bytes.byteLength, limit: SEALED_SNAPSHOT_LIMIT };
}

/** Return the local pending snapshot's oversize details without contacting the relay. */
export function pendingSnapshotSize(root) {
  return snapshotSize(loadLink(linkFile(root)));
}

/** Format a shared status line for an oversized sealed snapshot. */
export function formatSnapshotLimit(problem, { paused = false } = {}) {
  const size = `${(problem.sealedBytes / 1_000_000).toFixed(1)} MB`;
  const limit = `${(problem.limit / 1_000_000).toFixed(1)} MB`;
  if (paused) return `relay paused for ${problem.board}: snapshot ${size} over the relay limit ${limit}; it resumes on its own once a snapshot fits`;
  return `relay snapshot for ${problem.board}: sealed snapshot ${size} over the relay limit ${limit}`;
}

/** Keep a permanent refusal only as a bounded, credential-free diagnostic. */
function safePauseMessage(error) {
  const message = String(error.relayMessage ?? error.message ?? 'the relay refused the baseline upload')
    .replace(/https?:\/\/[^\s]+/gu, '[relay]')
    .replace(/\b(?:Bearer\s+)?(?:ps|pa|pm|pg)_[A-Za-z0-9_-]{20,}\b/gu, '[credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return message.slice(0, 240) || 'the relay refused the baseline upload';
}

/** Whether the CLI command will make an ordered move whose refusal should be reported at dispatch. */
function orderedMoveCommand(io) {
  const command = io.relayCommand;
  if (command?.cliOperation === 'spec') return ['approve', 'decline', 'apply'].includes(command.positionals?.[0]);
  return ORDERED_MOVE_COMMANDS.has(command?.cliOperation);
}

/** Give a local read a single safe explanation when its signed relay read is refused. */
function reportExpiredSignIn(state, io) {
  if (AUTH_NOTICES.has(io)) return;
  AUTH_NOTICES.add(io);
  const fix = process.env.PULLBOARD_RELAY_TOKEN !== undefined
    ? 'unset PULLBOARD_RELAY_TOKEN to use this machine credential or supply a current PULLBOARD_RELAY_TOKEN'
    : 'run pullboard relay on to sign in again or pullboard relay off to stop syncing';
  io.err(`pullboard: [AUTH_REQUIRED] relay sign-in expired or was revoked for board ${state.board}; ${fix}`);
}

/** Preserve the ordered-move refusal while naming this board and both recovery choices. */
function expiredSignInMoveRefusal(state, error) {
  const reason = safePauseMessage(error);
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined) {
    return new Refused('AUTH_REQUIRED', `the supplied PULLBOARD_RELAY_TOKEN was refused for board ${state.board}: ${reason}; unset PULLBOARD_RELAY_TOKEN to use this machine credential or supply a current PULLBOARD_RELAY_TOKEN`);
  }
  return new Refused('AUTH_REQUIRED', `relay sign-in expired or was revoked for board ${state.board}: ${reason}; run pullboard relay on to give this machine a credential or pullboard relay off to stop syncing`);
}

/** Pause only definitive baseline 4xx refusals; throttling and transient errors retain retries. */
function permanentBaselineRefusal(error) {
  return Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 &&
    ![408, 425, 429].includes(error.httpStatus);
}

/** Explain a refused later checkpoint without changing the ordered-move recovery policy. */
function checkpointProblem(state) {
  const refusal = state.checkpointRefusal;
  const code = safePauseCode(refusal);
  const reason = safePauseMessage(refusal);
  const size = snapshotSize(state);
  const next = 'upgrade pullboard (npm i -g pullboard) or run pullboard relay off then relay on --all';
  const message = `relay checkpoint refused for ${state.board}: ${code} ${reason}`
    + (size ? '; ' + formatSnapshotLimit(size) : '')
    + '; moves still sync in order; a fresh checkpoint goes up on the next change; if it keeps failing, ' + next;
  return { code: size ? 'RELAY_SNAPSHOT_LIMIT' : 'RELAY_CHECKPOINT_REFUSED', message, next };
}

/** Project the current checkpoint repair for doctor without making another network request. */
export function pendingCheckpointProblem(root) {
  const state = loadLink(linkFile(root));
  return state?.checkpointRefusal ? checkpointProblem(state) : null;
}

/** Deduplicate within one move, retaining its preflight notice and allowing later moves to warn. */
function reportCheckpointRefusal(state, io) {
  let boards = CHECKPOINT_NOTICES.get(io);
  if (!boards) { boards = new Set(); CHECKPOINT_NOTICES.set(io, boards); }
  if (boards.has(state.board)) return;
  boards.add(state.board);
  const line = 'pullboard: ' + checkpointProblem(state).message;
  if (['status', 'doctor'].includes(io.relayCommand?.cliOperation) && io.relayJson === false) io.say(line);
  else io.err(line);
}

/** Name the safe next step for the saved permanent refusal. */
function pauseFix(state) {
  const pause = state.baselinePause;
  if (pause.size || /(?:exceeds?|over|larger than|too large).{0,40}(?:bytes|snapshot|limit)|(?:snapshot|limit).{0,40}(?:exceeds?|over|too large)/iu.test(pause.message)) {
    return 'it resumes automatically once a snapshot fits';
  }
  if ([401, 403].includes(pause.status) || pause.code === 'AUTH_REQUIRED') return 'run pullboard relay on to sign in again';
  return 'upgrade Pullboard or run pullboard relay on again, then report the refusal if it persists';
}

/** Render one bounded line with board, safe refusal reason and recovery step. */
function baselinePauseLine(state) {
  const pause = state.baselinePause;
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(pause.code) ? pause.code : 'RELAY_REFUSED';
  const size = pause.size && Number.isSafeInteger(pause.size.sealedBytes) && Number.isSafeInteger(pause.size.limit)
    ? formatSnapshotLimit({ board: state.board, ...pause.size }, { paused: true }) : `relay paused for ${state.board} before its baseline upload`;
  return `pullboard: [${code}] ${size}: ${pause.message}; ${pauseFix(state)}`;
}

/** Report the durable pause once across preflight, move and postflight in one command. */
function reportBaselinePause(state, io) {
  if (!BASELINE_NOTICES.has(io)) {
    BASELINE_NOTICES.add(io);
    io.err(baselinePauseLine(state));
  }
}

/** Limit a paused board to one fresh baseline attempt within this command. */
function attemptedBaselineThisCommand(io, file) {
  let attempts = BASELINE_ATTEMPTS.get(io);
  if (!attempts) { attempts = new Set(); BASELINE_ATTEMPTS.set(io, attempts); }
  if (attempts.has(file)) return true;
  attempts.add(file);
  return false;
}

/** Retain an uncertain attempt in RAM so preflight failure cannot permit local fallback in this command. */
function rememberBaselineFailure(io, file, error) {
  let failures = BASELINE_FAILURES.get(io);
  if (!failures) { failures = new Map(); BASELINE_FAILURES.set(io, failures); }
  failures.set(file, error);
}

/** Confirm absence through authenticated API v1; a lost ACK or another live device must stay ordered. */
async function remoteBaselineAbsent(state, io) {
  try { await request(state, '/api/v1/boards/' + state.board + '/state', {}, io); }
  catch (error) {
    if (error.httpStatus === 404 && error.relayVersion === 1 && ['NO_BOARD', 'NO_SNAPSHOT'].includes(error.code)) return true;
    throw error;
  }
  return false;
}

/** Persist only a stable refusal code, never arbitrary relay text masquerading as a code. */
function safePauseCode(error) {
  const code = error.relayCode ?? error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RELAY_REFUSED';
}

/** Keep a conflicting remote baseline fenced across process restarts without discarding local work. */
function requireUnconflictedBaseline(state) {
  if (state.baselineConflict) throw new Refused('RELAY_BASELINE_EXISTS', 'the relay already holds this board; save the local board with pullboard export, then run pullboard relay off to keep working locally; local moves stay off to protect its ordered history');
}

/** Preserve the unaccepted local candidate and persist a refusal across process restarts. */
function fenceBaseline(file, state) {
  state.baselineAccepted = true;
  state.baselineConflict = true;
  delete state.baselinePause;
  saveLink(file, state);
  requireUnconflictedBaseline(state);
}

/** Fence another device's baseline before a retry can replace its sequence-zero snapshot. */
async function requireAbsentBaseline(file, state, io) {
  if (!await remoteBaselineAbsent(state, io)) {
    fenceBaseline(file, state);
  }
}

/** Send the sequence-zero board image; only its first permanent HTTP refusal pauses relay sends. */
async function uploadInitialBaseline(root, file, state, io) {
  attemptedBaselineThisCommand(io, file);
  try {
    await requireAbsentBaseline(file, state, io);
    const pending = state.snapshot;
    const reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: pending, initialBaseline: true }, io);
    if (reply.state?.sequence !== pending.sequence || reply.state.sealed !== pending.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the initial snapshot; retry the configured relay');
    state.baselineAccepted = true;
    state.cursor = Number.isSafeInteger(state.baselineCursor) ? state.baselineCursor : localRecords(root, (board) => board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
    delete state.baselineCursor;
    delete state.baselinePause;
    delete state.snapshot;
    state.presentationDigest = state.snapshotPresentationDigest ?? state.presentationDigest;
    delete state.snapshotPresentationDigest;
    state.needsPresentation = false;
    saveLink(file, state);
    return true;
  } catch (error) {
    if (error.relayVersion === 1 && error.code === 'BASELINE_EXISTS') fenceBaseline(file, state);
    if (!permanentBaselineRefusal(error) || state.baselineAccepted) {
      rememberBaselineFailure(io, file, error);
      throw error;
    }
    try {
      await requireAbsentBaseline(file, state, io);
    } catch (uncertain) {
      rememberBaselineFailure(io, file, uncertain);
      throw uncertain;
    }
    const size = pendingSnapshotSize(root);
    state.baselinePause = {
      status: error.httpStatus,
      code: safePauseCode(error),
      message: safePauseMessage(error),
      ...(size ? { size: { sealedBytes: size.sealedBytes, limit: size.limit } } : {}),
    };
    delete state.snapshot;
    delete state.snapshotPresentationDigest;
    delete state.baselineCursor;
    saveLink(file, state);
    reportBaselinePause(state, io);
    return false;
  }
}

/** Rebuild from current local state once per command, so paused moves become the accepted baseline. */
async function retryPausedBaseline(root, file, state, io) {
  if (!state.baselinePause || attemptedBaselineThisCommand(io, file)) return !state.baselinePause;
  try {
    const document = relaySnapshot(root);
    state.snapshot = { sequence: 0, sealed: await sealedRecord(readBoardKey(state.board), document, state, 'snapshot', 0) };
    state.snapshotPresentationDigest = presentationDigest(document.presentation);
    state.baselineCursor = document.tables.event.at(-1)?.event_id ?? 0;
    saveLink(file, state);
    const accepted = await uploadInitialBaseline(root, file, state, io);
    if (!accepted) reportBaselinePause(state, io);
    return accepted;
  } catch (error) {
    rememberBaselineFailure(io, file, error);
    throw error;
  }
}

/** Seal a client record at its proposed public sequence, with no board key in its envelope. */
async function sealedRecord(key, value, state, kind, sequence) {
  const plain = Buffer.from(JSON.stringify(value));
  const content = kind === 'snapshot' ? gzipSync(plain) : plain;
  return Buffer.from(await seal(key, content, { boardId: state.board, kind, sequence })).toString('base64url');
}

/** Catch up in local order, retaining exact ciphertext so a lost response cannot duplicate a move. */
async function flushMirror(root, file, state, io) {
  const key = readBoardKey(state.board);
  const path = '/api/v1/boards/' + state.board;
  if (state.linkPending) {
    await request(state, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository: state.repository } }, io);
    delete state.linkPending;
    saveLink(file, state);
  }
  if (state.snapshot) {
    const pendingSnapshot = state.snapshot;
    const uploaded = await request(state, path + '/state', { method: 'PUT', body: pendingSnapshot }, io);
    if (uploaded.state?.sequence !== pendingSnapshot.sequence || uploaded.state.sealed !== pendingSnapshot.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the queued snapshot; retry the configured relay');
    if (state.snapshotPresentationDigest) state.presentationDigest = state.snapshotPresentationDigest;
    delete state.snapshotPresentationDigest;
    state.needsPresentation = false;
    delete state.snapshot;
    saveLink(file, state);
  }
  // Reading on every linked command also delivers the relay's inactivity warning.
  const remote = await request(state, path + '/events?after=' + state.sequence, {}, io);
  const received = remote.events;
  if (!Array.isArray(received) || received.some((event, index) => !event ||
      event.event_id !== (index ? received[index - 1].event_id : state.sequence) + 1 ||
      !['move', 'request'].includes(event.kind) || typeof event.sealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(event.sealed))) {
    throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered event prefix; retry the configured relay');
  }
  // A mirror-only client cannot attest a checkpoint covering another device's unseen moves.
  if (received.some(event => !(state.pending && event.event_id === state.pending.sequence && event.sealed === state.pending.sealed && event.kind === 'move'))) {
    throw new Refused('RELAY_REPLAY_REQUIRED', 'another device changed this board; upgrade to a relay-order client before publishing a checkpoint or further queued moves');
  }
  if (state.pending) {
    const accepted = received.find((event) => event.event_id === state.pending.sequence && event.sealed === state.pending.sealed && event.kind === 'move');
    if (accepted) {
      state.cursor = state.pending.localEvent;
      state.needsPresentation = Boolean(state.needsPresentation || state.pending.needsPresentation || !state.pending.presentationDigest);
      if (state.pending.presentationDigest) state.presentationDigest = state.pending.presentationDigest;
      delete state.pending;
    }
  }
  if (received.length) state.sequence = Math.max(state.sequence, ...received.map((event) => event.event_id));
  if (state.pending && state.pending.sequence <= state.sequence) delete state.pending;
  saveLink(file, state);
  const rows = localRecords(root, (board) => store.events(board).filter((event) => event.event_id > state.cursor));
  for (const event of rows) {
    if (!state.pending) {
      const sequence = state.sequence + 1;
      const current = relayPresentation(root);
      // Only a projection ending at this local record belongs to its relay position.
      const presentation = current.state.events[0]?.event_id === event.event_id ? current : undefined;
      state.pending = { localEvent: event.event_id, sequence, needsPresentation: Boolean(state.needsPresentation || !presentation), ...(presentation ? { presentationDigest: presentationDigest(presentation) } : {}),
        sealed: await sealedRecord(key, { version: 1, engine: ENGINE_VERSION, event, presentation }, state, 'move', sequence) };
      saveLink(file, state);
    }
    const { sequence, sealed } = state.pending;
    const reply = await request(state, path + '/moves', { method: 'POST', body: { sequence, sealed } }, io);
    if (reply.event?.event_id !== sequence || reply.event.sealed !== sealed) throw new Refused('RELAY_RESPONSE', 'the relay acknowledgement does not match the queued record; retry after checking the relay');
    state.sequence = sequence;
    state.cursor = event.event_id;
    state.needsPresentation = Boolean(state.needsPresentation || state.pending.needsPresentation);
    if (state.pending.presentationDigest) state.presentationDigest = state.pending.presentationDigest;
    delete state.pending;
    saveLink(file, state);
  }
  const presentation = relayPresentation(root);
  const digest = presentationDigest(presentation);
  if (state.needsPresentation || state.presentationDigest !== digest) {
    const document = relaySnapshot(root);
    if ((document.tables.event.at(-1)?.event_id ?? 0) !== state.cursor) throw new Refused('RELAY_PRESENTATION_PENDING', 'new local moves arrived while syncing; run pullboard status again before publishing their presentation');
    state.snapshot = { sequence: state.sequence, sealed: await sealedRecord(key, document, state, 'snapshot', state.sequence) };
    state.snapshotPresentationDigest = presentationDigest(document.presentation);
    saveLink(file, state);
    const pendingSnapshot = state.snapshot;
    const uploaded = await request(state, path + '/state', { method: 'PUT', body: pendingSnapshot }, io);
    if (uploaded.state?.sequence !== pendingSnapshot.sequence || uploaded.state.sealed !== pendingSnapshot.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the refreshed presentation; retry the configured relay');
    state.presentationDigest = state.snapshotPresentationDigest;
    delete state.snapshotPresentationDigest;
    state.needsPresentation = false;
    delete state.snapshot;
    saveLink(file, state);
  }
  return summary(root, state);
}

/** A saved link is the opt-in boundary; unlinked callers neither read keys nor contact the relay. */
export function relayLinked(root) { return Boolean(loadLink(linkFile(root))); }

/** Authenticate and decode one opaque relay record on this device alone. */
async function decoded(key, record, state, kind, sequence) {
  const bytes = Buffer.from(record.sealed, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== record.sealed) throw new Refused('RELAY_RESPONSE', 'the relay returned invalid sealed bytes; fetch the board again');
  const plain = await unseal(key, bytes, { boardId: state.board, kind, sequence });
  try {
    if (kind === 'snapshot') {
      if (plain[0] === 0x1f && plain[1] === 0x8b) return JSON.parse(gunzipSync(plain).toString('utf8'));
      if (plain[0] !== 0x7b) throw new Refused('SNAPSHOT_FORMAT', `the sealed snapshot starts with ${Buffer.from(plain.subarray(0, 4)).toString('hex') || 'no bytes'}; expected gzip magic 1f8b or legacy JSON starting with 7b`);
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }
  catch (error) {
    if (error instanceof Refused) throw error;
    if (kind === 'snapshot') throw new Refused('SNAPSHOT_FORMAT', 'the sealed snapshot has gzip magic or legacy JSON bytes but cannot be read; refresh it from a linked machine');
    throw new Refused('RELAY_MOVE', 'the authenticated relay document is invalid; upgrade pullboard or restore a consistent snapshot');
  }
}

/** Replay one authenticated record, auto-refusing only deterministic current-format record failures. */
async function replayRelayRecord(board, key, state, record) {
  let move;
  try {
    move = await decoded(key, record, state, record.kind, record.event_id);
    requireSupportedEngine(move);
    if (record.kind === 'request') return receivePersonRequest(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender });
    return applyRelayMove(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind,
      digest: createHash('sha256').update(record.sealed).digest('hex') });
  } catch (error) {
    if (!(error instanceof Refused) || !['RELAY_MOVE', 'RELAY_RESPONSE', 'SEAL_FORMAT', 'SEAL_AUTH_FAILED'].includes(error.code)) throw error;
    return refuseRelayMove(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind,
      code: error.code === 'SEAL_AUTH_FAILED' ? 'RELAY_SEAL' : error.code,
      digest: createHash('sha256').update(String(record.sealed)).digest('hex'),
      refusal: error.code === 'SEAL_AUTH_FAILED'
        ? new Refused('RELAY_SEAL', 'this relay record failed authentication and was logged as refused; run pullboard relay to continue with the next ordered record')
        : error });
  }
}

/** Persist the exact checkpoint before uploading, so a lost reply retries identical ciphertext. */
async function publishCheckpoint(root, file, state, io) {
  if (!state.token?.startsWith('pm_') || process.env.PULLBOARD_RELAY_TOKEN) return;
  const document = relaySnapshot(root);
  const sequence = Number(document.tables.board_meta.find((row) => row.meta_key === 'relay_applied_sequence')?.meta_value ?? 0);
  const digest = presentationDigest(document.presentation);
  if (!state.checkpoint || state.checkpoint.sequence !== sequence || state.checkpointPresentationDigest !== digest) {
    delete state.checkpointRefusal;
    state.checkpointPresentationDigest = digest;
    state.checkpoint = { sequence, sealed: await sealedRecord(readBoardKey(state.board), document, state, 'snapshot', sequence) };
    saveLink(file, state);
  }
  // A definitive rejection retries only a fresh image after the board changes.
  if (state.checkpointRefusal) { reportCheckpointRefusal(state, io); return; }
  let reply;
  try { reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: state.checkpoint }, io); }
  catch (error) {
    if (!(error instanceof Refused) || !permanentBaselineRefusal(error)) throw error;
    state.checkpointRefusal = { code: safePauseCode(error), message: safePauseMessage(error), status: error.httpStatus };
    saveLink(file, state);
    reportCheckpointRefusal(state, io);
    return;
  }
  if (reply.state?.sequence !== state.checkpoint.sequence || reply.state.sealed !== state.checkpoint.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge this checkpoint; retry the configured relay');
  state.presentationDigest = state.checkpointPresentationDigest;
  delete state.checkpoint;
  delete state.checkpointPresentationDigest;
  saveLink(file, state);
}

/** Drain a legacy source once, refusing foreign history before it can be silently checkpointed. */
async function ensureOrdered(root, file, state, io) {
  requireUnconflictedBaseline(state);
  const previousFailure = BASELINE_FAILURES.get(io)?.get(file);
  if (previousFailure) throw previousFailure;
  if (state.mode === 'ordered') {
    // Older links with no pending sequence-zero snapshot necessarily accepted their baseline.
    if (state.baselineAccepted === undefined) {
      state.baselineAccepted = !(state.snapshot?.sequence === 0);
    }
    if (state.baselinePause) {
      if (!await retryPausedBaseline(root, file, state, io)) return false;
    }
    if (state.linkPending) {
      await request(state, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository: state.repository } }, io);
      delete state.linkPending;
      saveLink(file, state);
    }
    if (state.snapshot) {
      if (!state.baselineAccepted && state.snapshot.sequence === 0) {
        if (!await uploadInitialBaseline(root, file, state, io)) return false;
      } else {
        const reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: state.snapshot }, io);
        if (reply.state?.sequence !== state.snapshot.sequence || reply.state.sealed !== state.snapshot.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the initial snapshot; retry the configured relay');
        delete state.snapshot;
        saveLink(file, state);
      }
    }
    return true;
  }
  if (!state.checkpoint) {
    const path = '/api/v1/boards/' + state.board;
    if (!state.linkPending && !state.snapshot) {
      let remote;
      try { remote = await request(state, path + '/events?after=' + state.sequence, {}, io); }
      catch (error) {
        if (error.code !== 'SNAPSHOT_REQUIRED') throw error;
        const checkpoint = await request(state, path + '/state', {}, io);
        throw new Refused('RELAY_DIVERGED', `relay sequence ${checkpoint.state?.sequence ?? 'unknown'} differs from this mirror's local sequence ${state.sequence}; run pullboard relay off then relay on to re-link from this machine, or join by pairing`);
      }
      const unknown = remote.events?.filter((record) => !(state.pending && record.event_id === state.pending.sequence && record.sealed === state.pending.sealed));
      if (!Array.isArray(remote.events) || unknown.length) {
        const remoteSequence = remote.events?.at(-1)?.event_id ?? state.sequence;
        throw new Refused('RELAY_DIVERGED', `relay sequence ${remoteSequence} differs from this mirror's local sequence ${state.sequence}; run pullboard relay off then relay on to re-link from this machine, or join by pairing`);
      }
    }
    await flushMirror(root, file, state, io);
    localRecords(root, (board) => checkpointSequence(board, state.sequence));
  }
  await publishCheckpoint(root, file, state, io);
  state.mode = 'ordered';
  state.baselineAccepted = true;
  saveLink(file, state);
  return true;
}

/** Restore a compacted, authenticated native prefix before receiving any following operations. */
async function restoreCheckpoint(root, state, io, key) {
  const document = await request(state, '/api/v1/boards/' + state.board + '/state', {}, io);
  const snapshot = document.state;
  if (!snapshot || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Refused('RELAY_RESPONSE', 'the relay snapshot has no valid coverage sequence; fetch it again');
  const senderProblem = relaySenderProblem(null, snapshot.sender, 'snapshot');
  if (senderProblem) throw senderProblem;
  const native = await decoded(key, snapshot, state, 'snapshot', snapshot.sequence);
  localRecords(root, (board) => restoreRelaySnapshot(board, native, snapshot.sequence));
}

/** Apply a validated relay prefix with durable, transaction-bound receipts on this replica. */
async function catchUp(root, file, state, io) {
  const key = readBoardKey(state.board);
  const after = localRecords(root, appliedSequence);
  let remote;
  try { remote = await request(state, '/api/v1/boards/' + state.board + '/events?after=' + after, {}, io); }
  catch (error) {
    if (error.code !== 'SNAPSHOT_REQUIRED') throw error;
    await restoreCheckpoint(root, state, io, key);
    if (localRecords(root, appliedSequence) <= after) throw new Refused('RELAY_RESPONSE', 'the relay checkpoint did not advance the missing prefix; fetch a consistent newer snapshot');
    return catchUp(root, file, state, io);
  }
  if (!Array.isArray(remote.events) || remote.events.some((record, index) => !record || record.event_id !== after + index + 1 || !['move', 'request'].includes(record.kind) || typeof record.sealed !== 'string')) {
    throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered prefix; fetch a consistent relay snapshot');
  }
  let pendingRefusal;
  for (const record of remote.events) {
    const board = store.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
    let outcome;
    try { outcome = await replayRelayRecord(board, key, state, record); } finally { store.closeBoard(board); }
    // Exact ciphertext identifies an interrupted send even when its document was refused before replay.
    if (record.kind === 'move' && state.pending?.move && record.event_id === state.pending.sequence
        && record.sealed === state.pending.sealed && outcome?.error
        && !localRecords(root, board => engineReceipt(board, state.pending.move.id))) {
      pendingRefusal = outcome.error;
      delete state.pending;
      delete state.recovered;
    }
  }
  state.sequence = localRecords(root, appliedSequence);
  if (state.pending?.move && localRecords(root, (board) => engineReceipt(board, state.pending.move.id))) {
    state.recovered = state.pending;
    delete state.pending;
  }
  saveLink(file, state);
  if (pendingRefusal) throw new Refused(pendingRefusal.code, pendingRefusal.message);
}

/** Finish a durable executable send; a collision reseals its unchanged id after applying the winner. */
async function sendPending(root, file, state, io) {
  let renewedAgentToken = false;
  for (let tries = 0; state.pending && tries < 100; tries += 1) {
    const pending = state.pending;
    try {
      const transport = await actorTransport(root, file, state, credentialActor(pending.move), io);
      const reply = await request(transport, '/api/v1/boards/' + state.board + '/moves', { method: 'POST', body: { sequence: pending.sequence, sealed: pending.sealed } }, io);
      if (reply.event?.event_id !== pending.sequence || reply.event.sealed !== pending.sealed) throw new Refused('RELAY_RESPONSE', 'the relay acknowledgement differs from this executable send; fetch the configured relay');
    } catch (error) {
      const actor = credentialActor(pending.move);
      if (error.code === 'AUTH_REQUIRED' && !renewedAgentToken && actor !== 'machine' && actor !== 'person'
          && process.env.PULLBOARD_RELAY_TOKEN === undefined && state.token?.startsWith('pm_') && state.agentTokens?.[actor]?.token) {
        // A revoked/expired PA cache can be replaced once by this board's existing PM credential.
        delete state.agentTokens[actor];
        saveLink(file, state);
        renewedAgentToken = true;
        await actorTransport(root, file, state, actor, io);
        continue;
      }
      if (!['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(error.code)) throw error;
      await catchUp(root, file, state, io);
      if (state.pending) {
        state.pending.sequence = state.sequence + 1;
        state.pending.sealed = await sealedRecord(readBoardKey(state.board), state.pending.move, state, 'move', state.pending.sequence);
        saveLink(file, state);
      }
      continue;
    }
    await catchUp(root, file, state, io);
  }
  if (state.pending) throw new Refused('RELAY_BUSY', 'the relay order stayed busy; retry this command after other clients finish');
}

/** Choose credentials only; main's relay sender policy remains the sole replay authorization. */
function credentialActor(move) {
  const args = move.args;
  if (move.personRequest || ['register', 'ensureCoordinator'].includes(move.operation)) return 'machine';
  if (['recordRowDecisions', 'recordLandingWaiver'].includes(move.operation)
    || move.operation === 'answerDecision' && args[1]?.asPerson
    || move.operation === 'shout' && args[0]?.request) return 'person';
  return relayMoveActor(move);
}

/** Select a scoped credential; sendPending alone may renew a failed cached token once. */
async function actorTransport(root, file, state, actor, io) {
  if (typeof actor !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(actor)) {
    throw new Refused('RELAY_ACTOR', 'name the registered agent performing this move before sending it');
  }
  if (actor === 'person') {
    throw new Refused('HUMAN_REQUIRED', 'send this person action from the paired phone');
  }
  if (actor === 'machine') {
    if (!state.token?.startsWith('pm_')) throw new Refused('HUMAN_REQUIRED', 'run pullboard relay on --all to authorize this board’s machine credential');
    return state;
  }
  const supplied = process.env.PULLBOARD_RELAY_TOKEN;
  if (supplied !== undefined) {
    if (!/^pa_[A-Za-z0-9_-]{43}$/.test(supplied)) throw new Refused('AUTH_REQUIRED', 'supply a current scoped board token, without including it in command arguments');
    const transport = { ...state, token: supplied, agent: actor };
    const identity = await request(transport, '/auth/session?board=' + state.board, {}, io);
    if (identity.session?.kind !== 'board' || identity.session.agent !== actor) throw new Refused('RELAY_ACTOR', 'use the scoped token belonging to this move’s registered agent');
    return transport;
  }
  if (state.token?.startsWith('pa_')) {
    const identity = await request(state, '/auth/session?board=' + state.board, {}, io);
    if (identity.session?.agent !== actor) throw new Refused('RELAY_ACTOR', 'use the scoped token belonging to this move’s registered agent');
    return { ...state, agent: actor };
  }
  state.agentTokens ??= {};
  if (!state.agentTokens[actor]) {
    if (!localRecords(root, (board) => store.listAgents(board).some((agent) => agent.agent_id === actor))) {
      throw new Refused('RELAY_ACTOR', 'register this agent in the ordered board before obtaining its scoped token');
    }
    const issued = await request(state, '/auth/tokens', { method: 'POST', body: { board: state.board, agent: actor } }, io);
    if (!/^pa_[A-Za-z0-9_-]{43}$/.test(issued.token) || issued.board !== state.board || issued.agent !== actor ||
        typeof issued.id !== 'string' || !Number.isSafeInteger(issued.expires)) {
      throw new Refused('RELAY_RESPONSE', 'the relay did not issue this agent’s scoped credential; ask the person to retry enrollment');
    }
    state.agentTokens[actor] = { id: issued.id, token: issued.token, expires: issued.expires };
    saveLink(file, state);
  }
  return { ...state, token: state.agentTokens[actor].token, agent: actor };
}

/** Compare caller intent without executing frozen callbacks or allocating another operation id. */
function operationIntent(operation, args) {
  const values = Array.isArray(args) ? args.map((value, index) => {
    if (!['claim', 'refreeze'].includes(operation) || index !== 1 || !value || typeof value !== 'object') return value;
    const options = { ...value };
    delete options.freeze;
    delete options.frozen;
    delete options.freezeError;
    return options;
  }) : args;
  return JSON.stringify({ operation, args: values }, (_key, value) => typeof value === 'function' ? undefined : value);
}

/** Keep a recovered outcome until its caller repeats the interrupted operation to receive it. */
function recoveredMove(root, state, operation, args, command) {
  if (!state.recovered) return null;
  const recovered = state.recovered;
  const intent = recovered.intent ?? operationIntent(recovered.move.operation, recovered.move.args);
  const matches = recovered.commandIntent === undefined
    ? intent === operationIntent(operation, args)
    : recovered.move.operation === operation && recovered.commandIntent === operationIntent('cli:' + command?.cliOperation, command);
  if (!matches) {
    throw new Refused('RELAY_RETRY_PENDING', 'the previous move reached the relay; repeat that interrupted command to receive its original outcome before sending a different move');
  }
  const receipt = localRecords(root, (board) => engineReceipt(board, recovered.move.id));
  if (!receipt) throw new Refused('RELAY_RESPONSE', 'the recovered operation has no replay receipt; fetch a consistent relay snapshot before retrying');
  if (receipt.move !== JSON.stringify(recovered.move)) {
    throw new Refused('RELAY_MOVE', 'the recovered operation differs from its durable receipt; restore consistent relay metadata before retrying');
  }
  return recovered.move;
}

/** Send one board operation before executing it locally, and report its canonical engine result. */
export async function relayOperation(root, operation, args, io, command, applyLocally) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state || state.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish unlinking this device with pullboard relay off before sending a move');
    if (state.recovery) throw new Refused('RELAY_RECOVERY_PENDING', `finish the saved recovery for sequence ${state.recovery.skip} before sending a linked move`);
    let moves = CHECKPOINT_MOVES.get(io);
    if (!moves) { moves = new Set(); CHECKPOINT_MOVES.set(io, moves); }
    if (moves.has(state.board)) CHECKPOINT_NOTICES.get(io)?.delete(state.board);
    moves.add(state.board);
    /** Apply through the CLI's existing board handle so local events and guards remain unchanged. */
    const applyPausedMoveLocally = () => typeof applyLocally === 'function'
      ? applyLocally()
      : localRecords(root, (board) => store[operation](board, ...args));
    try {
      if (!await ensureOrdered(root, file, state, io)) {
        // Preflight's notice covers the first move; long-running commands still name every later move.
        if (BASELINE_LOCAL_MOVES.has(io)) BASELINE_NOTICES.delete(io);
        reportBaselinePause(state, io);
        BASELINE_LOCAL_MOVES.add(io);
        return applyPausedMoveLocally();
      }
      await catchUp(root, file, state, io);
      if (state.pending) {
        delete state.pending;
        saveLink(file, state);
      }
      const previousReceipt = io.personRequestMoveId && localRecords(root, board => engineReceipt(board, io.personRequestMoveId));
      if (previousReceipt) {
        if (state.recovered?.move?.id === io.personRequestMoveId) {
          delete state.recovered;
          saveLink(file, state);
        }
        if (previousReceipt.outcome.error) throw new Refused(previousReceipt.outcome.error.code, previousReceipt.outcome.error.message);
        for (const event of previousReceipt.outcome.events ?? []) io.onEvent?.(event);
        return previousReceipt.outcome.result;
      }
      let move = recoveredMove(root, state, operation, args, command);
      if (!move) {
        move = localRecords(root, (board) => prepareEngineMove(board, operation, args, io.personRequestMoveId ? { id: io.personRequestMoveId } : {}));
        if (io.personRequest) move.personRequest = structuredClone(io.personRequest);
        const problem = move.personRequest && localRecords(root, board => requestMoveProblem(board, move, { checkExecutorLease: false }));
        if (problem) throw problem;
        move.actor = relayMoveActor(move) ?? credentialActor(move);
        await actorTransport(root, file, state, credentialActor(move), io);
        const sequence = state.sequence + 1;
        state.pending = { move, intent: operationIntent(operation, args),
          ...(command ? { command, commandIntent: operationIntent('cli:' + command.cliOperation, command) } : {}), sequence,
          sealed: await sealedRecord(readBoardKey(state.board), move, state, 'move', sequence) };
        saveLink(file, state);
        try { await sendPending(root, file, state, io); }
        catch (error) {
          if (!['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(error.code)) throw error;
          // A lost acknowledgement can be recovered now without asking the caller to retry side effects.
          try { await catchUp(root, file, state, io); } catch { throw error; }
          if (!localRecords(root, (board) => engineReceipt(board, move.id))) throw error;
        }
      }
      const receipt = localRecords(root, (board) => engineReceipt(board, move.id));
      if (!receipt) throw new Refused('RELAY_RESPONSE', 'the acknowledged operation has no replay receipt; fetch a consistent relay snapshot');
      delete state.recovered;
      saveLink(file, state);
      // A phone can read a compacted checkpoint; failed presentation uploads do not undo the move.
      try { await publishCheckpoint(root, file, state, io); }
      catch (error) {
        if (!(error instanceof Refused)) throw error;
        if (error.code === 'AUTH_REQUIRED') reportExpiredSignIn(state, io);
        else io.err(`pullboard: ${error.message}`);
      }
      if (receipt.outcome.error) throw new Refused(receipt.outcome.error.code, receipt.outcome.error.message);
      if (['register', 'ensureCoordinator'].includes(operation)) await actorTransport(root, file, state, receipt.outcome.result, io);
      for (const event of receipt.outcome.events ?? []) io.onEvent?.(event);
      return receipt.outcome.result;
    } catch (error) {
      if (error instanceof Refused && error.code === 'AUTH_REQUIRED') throw expiredSignInMoveRefusal(state, error);
      throw error;
    }
  });
}

/** Catch up an opted-in replica before/after a CLI command; offline reads retain local evidence. */
export async function syncRelay(root, io) {
  // Reuse Git discovery only within this command; still re-read the link before each retry.
  let files = LINK_FILES.get(io);
  if (!files) { files = new Map(); LINK_FILES.set(io, files); }
  const file = files.get(root) ?? linkFile(root);
  files.set(root, file);
  if (!existsSync(file)) return null;
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) return null;
    if (state.unlinking) { io.err('pullboard: [RELAY_UNLINK_PENDING] the remote board is deleted; run pullboard relay off to finish forgetting this device key'); return summary(root, state); }
    try {
      if (state.recovery) throw new Refused('RELAY_RECOVERY_PENDING', `a relay recovery for sequence ${state.recovery.skip} is pending; retry pullboard relay recover --skip ${state.recovery.skip} before syncing`);
      if (!await ensureOrdered(root, file, state, io)) return summary(root, state);
      await catchUp(root, file, state, io);
      if (state.pending) {
        // The complete prefix did not acknowledge this interrupted send. It must not run later.
        delete state.pending;
        saveLink(file, state);
        io.err(`pullboard: the relay ${state.url} did not sequence the previous move; retry that move explicitly if still wanted`);
      }
      if (state.checkpoint || state.presentationDigest !== presentationDigest(relayPresentation(root))) await publishCheckpoint(root, file, state, io);
      await deliverDeviceWraps(root, io);
      return summary(root, state);
    }
    catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (error.code === 'RELAY_KEY_MISSING') {
        if (!KEY_WARNED_COMMANDS.has(io)) {
          KEY_WARNED_COMMANDS.add(io);
          io.err(`pullboard: ${error.message}; moves are off until the key is reachable`);
        }
      } else if (error.code === 'AUTH_REQUIRED') {
        if (!orderedMoveCommand(io)) reportExpiredSignIn(state, io);
      } else io.err(`pullboard: ${error.message}; run pullboard status to see pending uploads`);
      return { linked: true, board: state.board, url: state.url, sequence: state.sequence,
        behind: (state.mode === 'ordered' ? Number(Boolean(state.pending)) : behind(root, state)) + Number(Boolean(state.snapshot || state.checkpoint)),
        recovery: recoverySummary(state) };
    }
  });
}

/** Return token-management context without opening a board-key pairing link or exposing any credential. */
function tokenContext(state) {
  return { linked: true, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0, recovery: recoverySummary(state) };
}

/** Require the existing board delegate before listing metadata or requesting an approved revocation. */
function managementLink(file) {
  const state = loadLink(file);
  if (!state || state.unlinking) throw new Refused('RELAY_OFF', 'link this board with pullboard relay on before managing its agent tokens');
  return state;
}

/** List only this board’s agent-token metadata, never bearer values or the board key. */
export async function relayTokens(root, io) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = managementLink(file);
    const listed = await request(state, '/auth/tokens?board=' + state.board, {}, io);
    if (!Array.isArray(listed.tokens) || listed.tokens.some((row) => !row || row.board !== state.board ||
        typeof row.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id) ||
        typeof row.agent !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(row.agent) ||
        !Number.isSafeInteger(row.expires) || (row.created !== null && !Number.isSafeInteger(row.created)) ||
        typeof row.revoked !== 'boolean')) throw new Refused('RELAY_RESPONSE', 'the relay token inventory is invalid; retry its configured address');
    const tokens = listed.tokens.map(({ id, board, agent, created, expires, revoked }) => ({ id, board, agent, created, expires, revoked }));
    return { ...tokenContext(state), tokens };
  });
}

/** Revoke one credential listed on this board while retaining its cache so it cannot be silently reminted. */
export async function relayRevoke(root, id, io) {
  requirePersonChannel(io.personChannel);
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Refused('TOKEN_NOT_OWNED', 'name an opaque token id from pullboard relay tokens, never a credential value');
  }
  const file = linkFile(root);
  return locked(file, async () => {
    const state = managementLink(file);
    const listed = await request(state, '/auth/tokens?board=' + state.board, {}, io);
    if (!Array.isArray(listed.tokens) || !listed.tokens.some((row) => row.id === id)) {
      throw new Refused('TOKEN_NOT_OWNED', 'choose a token listed on this board by pullboard relay tokens');
    }
    const result = await nativePhoneAction(state, 'revoke-token', id, io, request);
    if (result.id !== id || result.revoked !== true) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge this token revocation; retry its opaque id');
    for (const credential of Object.values(state.agentTokens ?? {})) if (credential.id === id) credential.revoked = true;
    saveLink(file, state);
    return { ...tokenContext(state), id: result.id, revoked: result.revoked };
  });
}

/** Read an acknowledged exact CLI result before changed spec, brief or Git refs can block it. */
export async function relayCommandReceipt(root, command) {
  if (!command) return null;
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state || state.unlinking) return null;
    const recovered = state.recovered;
    if (!recovered || recovered.commandIntent !== operationIntent('cli:' + command.cliOperation, command)) return null;
    if (recovered.commandIntent !== operationIntent('cli:' + recovered.command?.cliOperation, recovered.command)) {
      throw new Refused('RELAY_STORAGE', 'restore the interrupted command metadata before retrying');
    }
    const expected = { add: 'addItem', edit: 'editItem', merged: 'merged' }[command.cliOperation];
    if (!recovered.move || recovered.move.operation !== expected) throw new Refused('RELAY_STORAGE', 'restore the interrupted command metadata before retrying');
    const move = recoveredMove(root, state, recovered.move.operation, recovered.move.args, command);
    const receipt = localRecords(root, board => engineReceipt(board, move.id));
    if (receipt.outcome.error) {
      delete state.recovered;
      saveLink(file, state);
      throw new Refused(receipt.outcome.error.code, receipt.outcome.error.message);
    }
    return { result: receipt.outcome.result, events: receipt.outcome.events ?? [], move };
  });
}

/** Consume the exact cached result after its original CLI outcome has been formatted. */
export async function relayCommandReceiptReported(root, moveId) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (state?.recovered?.move?.id === moveId) {
      delete state.recovered;
      saveLink(file, state);
    }
  });
}

/** Expose only an unreported operation descriptor so CLI preconditions cannot strand its outcome. */
export function relayRecovered(root) {
  return loadLink(linkFile(root))?.recovered?.move ?? null;
}

/** Explicitly refuse one blocked position, replay its valid tail on a private copy, then publish it. */
export async function relayRecover(root, skip, io) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state || state.unlinking || state.mode !== 'ordered') throw new Refused('RELAY_LINKED', 'link this ordered relay board before recovering a blocked sequence');
    const boardFile = join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite');
    const source = store.openBoard(boardFile);
    const staged = store.openBoard(':memory:');
    try {
      const cursor = appliedSequence(source);
      const sourceDigest = nativeBoardDigest(source);
      if (!Number.isSafeInteger(skip) || skip !== cursor + 1) throw new Refused('RELAY_SEQUENCE', `only the blocked next sequence ${cursor + 1} can be skipped; inspect pullboard relay and retry`);
      if (state.recovery && (state.recovery.skip !== skip || state.recovery.cursor !== cursor)) {
        throw new Refused('RELAY_RECOVERY_PENDING', `finish the saved recovery for sequence ${state.recovery.skip} before choosing another; retry pullboard relay recover --skip ${state.recovery.skip}`);
      }
      if (state.recovery && state.recovery.sourceDigest !== sourceDigest) throw new Refused('RELAY_LOCAL_CHANGED', 'the local board changed while recovery was pending; local rows are preserved, but this recovery cannot be retried from the changed board; keep an export and ask the person to reconcile the relay checkpoint');
      if (nativeBoardDigest(source) !== sourceDigest) throw new Refused('RELAY_LOCAL_CHANGED', 'the local board changed while recovery started; no recovery data was published, retry after preserving that change');
      importBoard(staged, exportBoard(source));
      const key = readBoardKey(state.board);
      if (state.recovery) {
        const saved = await request(state, '/api/v1/boards/' + state.board + '/state', {}, io);
        if (Number.isSafeInteger(saved.state?.sequence) && saved.state.sequence >= state.recovery.sequence) {
          const ownAcknowledgement = saved.state.sequence === state.recovery.sequence && saved.state.sealed === state.recovery.sealed;
          const senderProblem = relaySenderProblem(null, saved.state.sender, 'snapshot');
          if (senderProblem) throw senderProblem;
          const native = await decoded(key, saved.state, state, 'snapshot', saved.state.sequence);
          if (!recoveryRefusalMatches(native, state.recovery) || (!ownAcknowledgement && !state.recovery.blockerDigest)) {
            throw new Refused('RELAY_RECOVERY_PENDING', 'the checkpoint does not prove this blocked sequence was refused; keep this device unchanged and ask the person to inspect the relay checkpoint');
          }
          if (nativeBoardDigest(source) !== sourceDigest) throw new Refused('RELAY_LOCAL_CHANGED', 'the local board changed while recovery was pending; local rows are preserved, but this checkpoint cannot be adopted over those changes; keep an export and ask the person to reconcile the relay checkpoint');
          restoreRelaySnapshot(source, native, saved.state.sequence, sourceDigest);
          state.sequence = saved.state.sequence;
          state.cursor = saved.state.sequence;
          delete state.recovery;
          saveLink(file, state);
          return { ...summary(root, state), skipped: skip, ...(!ownAcknowledgement ? { adopted: true } : {}) };
        }
      }
      const remote = await request(state, '/api/v1/boards/' + state.board + '/events?after=' + cursor, {}, io);
      if (!Array.isArray(remote.events) || !remote.events.length || remote.events[0]?.event_id !== skip) throw new Refused('RELAY_SEQUENCE', `relay sequence ${skip} is not available as the next record; fetch the current relay prefix`);
      const blocker = remote.events[0];
      let decodedMove = null;
      let blockerCode = 'RELAY_RECORD';
      try {
        decodedMove = await decoded(key, blocker, state, blocker.kind, blocker.event_id);
        requireSupportedEngine(decodedMove);
        throw new Refused('RELAY_RECOVERY_HEALTHY', 'the selected record is readable by this pullboard version; run pullboard relay to replay it normally');
      } catch (error) {
        if (!(error instanceof Refused) || (error.code !== 'ENGINE_VERSION' && !['SEAL_VERSION', 'RELAY_MOVE', 'RELAY_RESPONSE', 'SEAL_FORMAT', 'SEAL_AUTH_FAILED'].includes(error.code))) throw error;
        blockerCode = error.code;
        // A person may explicitly bypass this one authenticated transport slot; it remains in the receipt log.
      }
      if (decodedMove?.engine > ENGINE_VERSION) blockerCode = 'ENGINE_VERSION';
      const blockerDigest = createHash('sha256').update(String(blocker.sealed)).digest('hex');
      refuseRelayMove(staged, decodedMove, { sequence: skip, at: blocker.event_at, sender: blocker.sender, kind: blocker.kind,
        code: blockerCode,
        digest: blockerDigest,
        refusal: new Refused(blockerCode, 'person recovery logged this blocked record as refused; run pullboard relay to apply the remaining ordered tail') });
      for (const record of remote.events.slice(1)) {
        try { await replayRelayRecord(staged, key, state, record); }
        catch (error) {
          // A later unsupported record needs its own explicit choice; it cannot undo this selected skip.
          if (!(error instanceof Refused) || !['ENGINE_VERSION', 'SEAL_VERSION'].includes(error.code)) throw error;
          break;
        }
      }
      const document = relaySnapshot(root, { board: staged });
      const sequence = appliedSequence(staged);
      if (nativeBoardDigest(source) !== sourceDigest) throw new Refused('RELAY_LOCAL_CHANGED', 'the local board changed while recovery was staged; no recovery checkpoint was published, export the new local change and retry');
      const candidate = state.recovery?.sequence === sequence
        ? { sequence, sealed: state.recovery.sealed }
        : { sequence, sealed: await sealedRecord(key, document, state, 'snapshot', sequence) };
      state.recovery = { skip, cursor, sourceDigest, blockerDigest, ...candidate };
      saveLink(file, state);
      const reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: candidate }, io);
      if (reply.state?.sequence !== sequence || reply.state.sealed !== candidate.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the recovery checkpoint; local board was left unchanged, retry recovery');
      if (nativeBoardDigest(source) !== sourceDigest) throw new Refused('RELAY_LOCAL_CHANGED', 'the local board changed before checkpoint acknowledgement; local rows are preserved, but the checkpoint may already be accepted and this recovery cannot be retried from the changed board; keep an export and ask the person to reconcile the relay checkpoint');
      restoreRelaySnapshot(source, document, sequence, sourceDigest);
      state.sequence = sequence;
      state.cursor = sequence;
      delete state.recovery;
      saveLink(file, state);
      return { ...summary(root, state), skipped: skip };
    } finally { store.closeBoard(staged); store.closeBoard(source); }
  });
}

/** Read the local link and lag without opening a network connection or revealing its relay token. */
export function relayStatus(root) { return summary(root, loadLink(linkFile(root))); }

/** Renew a person session through the relay without changing this device's board key or cursors. */
async function deviceSignIn(url, io) {
  const client = { url };
  const flow = await request(client, '/auth/device/start', { method: 'POST', body: {} }, io);
  io.stderr.write(`Sign in with GitHub: open ${flow.verificationURL} and enter ${flow.userCode}\n`);
  const expires = Date.now() + flow.expiresIn * 1000;
  let signed;
  let wait = flow.interval;
  do {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait) * 1000));
    if (Date.now() >= expires) throw new Refused('OAUTH_EXPIRED', 'GitHub device sign-in expired; run pullboard relay on again');
    signed = await request(client, '/auth/device/poll', { method: 'POST', body: { ticket: flow.ticket } }, io);
    wait = signed.retryAfter ?? flow.interval;
  } while (signed.pending);
  const token = signed.token;
  if (!/^ps_[A-Za-z0-9_-]{43}$/.test(token)) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
  return signed;
}

/** Explicitly sign in through the relay and persist a sealed initial snapshot before uploading it. */
export async function relayOn(root, address, io, { session, credential, quiet = false, strict = false } = {}) {
  if (!credential) requirePersonChannel(io.personChannel);
  readRelayMachine();
  for (const project of listApiProjects()) { try { loadLink(linkFile(project.root)); } catch { /* Report this command's own link below. */ } }
  const repository = originRepository(root);
  const file = linkFile(root);
  return locked(file, async () => {
    let state = loadLink(file);
    if (state) requireUnconflictedBaseline(state);
    if (state?.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish this device key cleanup with pullboard relay off before linking again');
    const url = relayOrigin(address || state?.url || DEFAULT_RELAY);
    if (state && (state.url !== url || state.repository !== repository)) throw new Refused('RELAY_LINKED', 'this board is linked to another relay or repository; run relay off before changing its link');
    const key = state ? readBoardKey(state.board) : await generateBoardKey();
    const signed = credential ?? session ?? await deviceSignIn(url, io);
    if (session && session.url !== url) throw new Refused('RELAY_SESSION', 'Sign in again to this relay with pullboard relay on --all.');
    if (!state) {
      const snapshot = localRecords(root, (board) => {
        startRelayEpoch(board);
        return { board: store.boardId(board) };
      });
      snapshot.document = relaySnapshot(root);
      // Save the device key before creating any remote link; a locked keychain cannot strand it.
      const keyStorage = storeBoardKey(snapshot.board, key);
      state = { version: 1, mode: 'ordered', board: snapshot.board, url, repository, token: null, personReauth: true,
        keyStorage, presentationDigest: presentationDigest(snapshot.document.presentation), sequence: 0,
        cursor: snapshot.document.tables.event.at(-1)?.event_id ?? 0, baselineCursor: snapshot.document.tables.event.at(-1)?.event_id ?? 0,
        baselineAccepted: false, linkPending: true };
      state.snapshot = { sequence: 0, sealed: await sealedRecord(key, snapshot.document, state, 'snapshot', 0) };
    }
    state.account = signed.account ?? signed.user?.id;
    // Persist the exact sealed snapshot and a recoverable link intent before making the remote link.
    saveLink(file, state);
    if (state.linkPending) {
      if (!credential) await request({ ...state, token: signed.token }, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository } }, io);
      delete state.linkPending;
      saveLink(file, state);
    }
    const machine = updateRelayMachine(settings => settings.machine);
    const issued = credential ?? await request({ ...state, token: signed.token }, '/auth/machines', { method: 'POST', body: { board: state.board, machine } }, io);
    if (!/^pm_[A-Za-z0-9_-]{43}$/u.test(issued.token ?? '') || issued.board !== state.board || issued.machine !== machine) throw new Refused('RELAY_RESPONSE', 'the relay did not issue this board’s machine credential; sign in again');
    state.token = issued.token;
    state.tokenId = issued.id;
    state.machine = machine;
    delete state.personReauth;
    saveLink(file, state);
    let result;
    try {
      let ready = true;
      if (state.mode === 'ordered' && state.snapshot) {
        if (!state.baselineAccepted && state.snapshot.sequence === 0) ready = await uploadInitialBaseline(root, file, state, io);
        else {
          const reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: state.snapshot }, io);
          if (reply.state?.sequence !== state.snapshot.sequence || reply.state.sealed !== state.snapshot.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the initial snapshot; retry the configured relay');
          delete state.snapshot;
          saveLink(file, state);
        }
      }
      if (ready) ready = await ensureOrdered(root, file, state, io);
      if (ready) {
        await catchUp(root, file, state, io);
        await deliverDeviceWraps(root, io);
        updateRelayMachine(machine => { machine.excluded = machine.excluded.filter(entry => entry !== repoInfo(root).root); });
      }
      result = summary(root, state, { pairing: !quiet });
    }
    catch (error) { if (strict || !(error instanceof Refused)) throw error; io.err(`pullboard: ${error.message}; pending records are queued for the next command`); result = summary(root, state, { pairing: !quiet }); }
    if (!quiet) io.say(terminalQr(result.link));
    return result;
  });
}

/** Unlink locally without approval, then request a separate phone-approved remote deletion if possible. */
export async function relayOff(root, io) {
  updateRelayMachine(machine => { const project = repoInfo(root).root; if (!machine.excluded.includes(project)) machine.excluded.push(project); });
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) return summary(root, null);
    // Local unlink always completes, including agent shells, outages and a fenced remote baseline.
    let proposal;
    try { proposal = await phoneProposal(state, 'delete-board', state.board); }
    catch { /* Missing key or pairing cannot stop local unlinking. */ }
    rmSync(file, { force: true });
    try { forgetBoardKey(state.board, state.keyStorage); }
    catch { /* The local opt-out is complete even when secure key storage is temporarily locked. */ }
    let requested = false;
    let remote;
    try {
      if (!proposal) throw new Refused('PHONE_NOT_PAIRED', 'Manage the relay copy from your phone.');
      await publishPhoneApproval(state, proposal, io, request);
      requested = true;
    } catch (error) {
      if (proposal) remote = warnPhoneApproval(proposal, error, io, 'Local link removed. Manage the relay copy from the phone, or relink this board and run pullboard relay off again explicitly.');
    }
    return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0, recovery: recoverySummary(null),
      ...(remote ? { remote } : {}),
      notice: 'Local link removed. The relay copy stays until you approve deleting it on your phone.' + (requested ? '' : ' Open the phone to manage the relay copy.') };
  });
}


/** Keep the elected native executor stable across processes while other worktrees share its link. */
export async function relayRequestDevice(root) {
  const file = linkFile(root);
  if (!existsSync(file)) return null;
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state || state.unlinking) return null;
    if (!state.requestDevice) { state.requestDevice = randomUUID(); saveLink(file, state); }
    return state.requestDevice;
  });
}

/** Sign in once for machine setup; the saved account is the provider-authenticated identity. */
export async function relayMachineSignIn(address, io) {
  requirePersonChannel(io.personChannel);
  const url = relayOrigin(address || DEFAULT_RELAY);
  const signed = await deviceSignIn(url, io);
  if (typeof signed.user?.id !== 'string') throw new Refused('RELAY_RESPONSE', 'Sign in again to receive an authenticated account identity.');
  return { token: signed.token, id: signed.id, account: signed.user.id, url };
}

/** Share the existing bounded transport only with fixed account/device endpoints. */
export async function relayDeviceRequest(session, path, options, io) {
  if (!path.startsWith('/api/v1/devices/')) throw new Refused('DEVICE_ENDPOINT', 'Use a supported relay device action.');
  return await request(session, path, options, io);
}

/** Deliver wraps only from the private local roster, rechecking revocation before each upload. */
export async function deliverDeviceWraps(root, io) {
  const state = loadLink(linkFile(root));
  if (!state || state.unlinking || !state.account) return;
  const devices = readRelayMachine().devices.filter(device => device.account === state.account && device.url === state.url);
  if (!devices.length) return;
  const key = readBoardKey(state.board);
  for (const device of devices) {
    const context = { board: state.board, device: device.deviceId, engine: ENGINE_VERSION };
    const wrapped = await wrapForRecordedDevice(key, context, state);
    await relayDeviceRequest(state, '/api/v1/devices/' + device.deviceId + '/boards/' + state.board,
      { method: 'PUT', body: { engine: ENGINE_VERSION, wrapped: Buffer.from(JSON.stringify(wrapped)).toString('base64url') } }, io);
  }
}

/** Expose board-scoped machine context only to the native setup/approval adapter. */
export function relayMachineContext(root) { return loadLink(linkFile(root)); }

/** Require one exact phone approval before revoking and removing a device from the trusted roster. */
export async function relayRevokeDevice(root, deviceId, io) {
  requirePersonChannel(io.personChannel);
  const state = managementLink(linkFile(root));
  const result = await nativePhoneAction(state, 'revoke-device', deviceId, io, request);
  removeRecordedDevice(deviceId);
  updateRelayMachine(machine => { machine.revocations = machine.revocations.filter(entry => entry.deviceId !== deviceId); });
  return { ...result, notice: 'Revoked device; keys it already received remain known. Board key rotation is separate.' };
}
