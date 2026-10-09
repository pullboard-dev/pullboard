/** Opt-in, sealed relay ordering, with crash-safe migration from the older mirror [H1,H3,H5,H16,H17,P5]. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import * as store from './board.js';
import { exportBoard, restoreRelaySnapshot } from './exchange.js';
import { appliedSequence, applyRelayMove, checkpointSequence, engineReceipt, prepareEngineMove, requireSupportedEngine, startRelayEpoch } from './engine.js';
import { relayMoveActor } from './relay-sender.js';
import { ENGINE_VERSION } from './machine.js';
import { presentationDigest, relayPresentation, relaySnapshot } from './relay-presentation.js';
import { repoInfo, tryGit } from './git.js';
import { forgetBoardKey, readBoardKey, storeBoardKey } from './relay-key.js';
import { encodeBoardKey, generateBoardKey, seal, unseal } from './seal.js';
import { terminalQr } from './qr.js';
import { Refused } from './refused.js';
import { relaySenderProblem } from './relay-sender.js';
import { readRelayMachine, updateRelayMachine, wrapForRecordedDevice } from './relay-machine.js';
import { receivePersonRequest } from './relay-requests.js';

export const DEFAULT_RELAY = 'https://app.pullboard.dev';
const SEALED_SNAPSHOT_LIMIT = 10_000_000;
const LINK_FILES = new WeakMap();
const WARNED_COMMANDS = new WeakSet();
const KEY_WARNED_COMMANDS = new WeakSet();
const BASELINE_ATTEMPTS = new WeakMap();
const BASELINE_NOTICES = new WeakSet();
const BASELINE_LOCAL_MOVES = new WeakSet();
const BASELINE_FAILURES = new WeakMap();

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
  if (!state || typeof state !== 'object' || state.version !== 1 || !/^[0-9a-f]{32}$/.test(state.board) || !/^(ps_|pa_)[A-Za-z0-9_-]{43}$/.test(state.token) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Refused('RELAY_STORAGE', 'restore supported relay link metadata before syncing this board');
  }
  relayOrigin(state.url);
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
  try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
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

/** Count unapplied uploads using durable event ids, without counting relay transport metadata. */
function behind(root, state) {
  return localRecords(root, (board) => board.db.prepare('SELECT COUNT(*) AS count FROM event WHERE event_id > ?').get(state.cursor).count);
}

/** Expose key-free link status; only an explicit link operation includes its pairing carrier. */
function summary(root, state, { pairing = false } = {}) {
  if (!state) return { linked: false, board: '', url: '', link: '', sequence: 0, behind: 0 };
  if (state.unlinking) return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0, cleanup: true };
  const fragment = pairing ? '&key=' + encodeBoardKey(readBoardKey(state.board)) : '';
  const oversizedSnapshot = snapshotSize(state);
  return { linked: true, board: state.board, url: state.url,
    link: 'https://app.pullboard.dev/#board=' + state.board + fragment,
    sequence: state.sequence, behind: (state.baselinePause ? behind(root, state) : state.mode === 'ordered' ? Number(Boolean(state.pending)) : behind(root, state)) + Number(Boolean(state.snapshot || state.checkpoint)),
    ...(oversizedSnapshot ? { oversizedSnapshot } : {}),
    ...(state.baselinePause ? { pausedUpload: structuredClone(state.baselinePause) } : {}) };
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
    .replace(/\b(?:Bearer\s+)?(?:ps|pa)_[A-Za-z0-9_-]{20,}\b/gu, '[credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return message.slice(0, 240) || 'the relay refused the baseline upload';
}

/** Pause only definitive baseline 4xx refusals; throttling and transient errors retain retries. */
function permanentBaselineRefusal(error) {
  return Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500 &&
    ![408, 425, 429].includes(error.httpStatus);
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

/** Persist the exact checkpoint before uploading, so a lost reply retries identical ciphertext. */
async function publishCheckpoint(root, file, state, io) {
  if (!state.token.startsWith('ps_') || process.env.PULLBOARD_RELAY_TOKEN) return;
  const document = relaySnapshot(root);
  const sequence = Number(document.tables.board_meta.find((row) => row.meta_key === 'relay_applied_sequence')?.meta_value ?? 0);
  const digest = presentationDigest(document.presentation);
  if (!state.checkpoint || state.checkpoint.sequence !== sequence || state.checkpointPresentationDigest !== digest) {
    state.checkpointPresentationDigest = digest;
    state.checkpoint = { sequence, sealed: await sealedRecord(readBoardKey(state.board), document, state, 'snapshot', sequence) };
    saveLink(file, state);
  }
  const reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: state.checkpoint }, io);
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
      saveLink(file, state);
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
  if (!Array.isArray(remote.events) || remote.events.some((record, index) => !record || record.event_id !== after + index + 1 || !['move', 'request'].includes(record.kind) || typeof record.sealed !== 'string' || !record.sender || !['person', 'agent'].includes(record.sender.kind) || typeof record.sender.userId !== 'string' || (record.sender.kind === 'agent' && typeof record.sender.agent !== 'string'))) {
    throw new Refused('RELAY_RESPONSE', 'the relay returned an invalid ordered prefix; fetch a consistent relay snapshot');
  }
  for (const record of remote.events) {
    const move = await decoded(key, record, state, record.kind, record.event_id);
    // Legacy executable documents in the request channel still fail closed before attribution.
    if (record.kind === 'request' && move?.engine !== undefined) requireSupportedEngine(move);
    localRecords(root, (board) => {
      if (record.kind === 'request') receivePersonRequest(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender });
      else applyRelayMove(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind });
    });
  }
  state.sequence = localRecords(root, appliedSequence);
  if (state.pending?.move && localRecords(root, (board) => engineReceipt(board, state.pending.move.id))) {
    state.recovered = state.pending;
    delete state.pending;
  }
  saveLink(file, state);
}

/** Finish a durable executable send; a collision reseals its unchanged id after applying the winner. */
async function sendPending(root, file, state, io) {
  for (let tries = 0; state.pending && tries < 100; tries += 1) {
    const pending = state.pending;
    try {
      const transport = await actorTransport(root, file, state, credentialActor(pending.move), io);
      const reply = await request(transport, '/api/v1/boards/' + state.board + '/moves', { method: 'POST', body: { sequence: pending.sequence, sealed: pending.sealed } }, io);
      if (reply.event?.event_id !== pending.sequence || reply.event.sealed !== pending.sealed) throw new Refused('RELAY_RESPONSE', 'the relay acknowledgement differs from this executable send; fetch the configured relay');
    } catch (error) {
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
  if (move.personRequest || ['register', 'ensureCoordinator', 'recordRowDecisions'].includes(move.operation)
    || move.operation === 'answerDecision' && args[1]?.asPerson
    || move.operation === 'shout' && args[0]?.request) return 'person';
  return relayMoveActor(move);
}

/** Select one scoped credential without renewing a revoked or expired agent cache. */
async function actorTransport(root, file, state, actor, io) {
  if (typeof actor !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(actor)) {
    throw new Refused('RELAY_ACTOR', 'name the registered agent performing this move before sending it');
  }
  if (actor === 'person') {
    if (!state.token.startsWith('ps_')) throw new Refused('HUMAN_REQUIRED', 'sign in as a person to enroll an agent or answer as the person');
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
  if (state.token.startsWith('pa_')) {
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
    /** Apply through the CLI's existing board handle so local events and guards remain unchanged. */
    const applyPausedMoveLocally = () => typeof applyLocally === 'function'
      ? applyLocally()
      : localRecords(root, (board) => store[operation](board, ...args));
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
    catch (error) { if (!(error instanceof Refused)) throw error; io.err(`pullboard: ${error.message}`); }
    if (receipt.outcome.error) throw new Refused(receipt.outcome.error.code, receipt.outcome.error.message);
    if (['register', 'ensureCoordinator'].includes(operation)) await actorTransport(root, file, state, receipt.outcome.result, io);
    for (const event of receipt.outcome.events ?? []) io.onEvent?.(event);
    return receipt.outcome.result;
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
      } else io.err(`pullboard: ${error.message}; run pullboard status to see pending uploads`);
      return { linked: true, board: state.board, url: state.url, sequence: state.sequence,
        behind: (state.mode === 'ordered' ? Number(Boolean(state.pending)) : behind(root, state)) + Number(Boolean(state.snapshot || state.checkpoint)) };
    }
  });
}

/** Return token-management context without opening a board-key pairing link or exposing any credential. */
function tokenContext(state) {
  return { linked: true, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0 };
}

/** Require the signed-in person's existing link before listing or revoking scoped agent credentials. */
function managementLink(file) {
  const state = loadLink(file);
  if (!state || state.unlinking) throw new Refused('RELAY_OFF', 'link this board with pullboard relay on before managing its agent tokens');
  return state;
}

/** List only this person's current board-token metadata, never bearer values or the board key. */
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
    const result = await request(state, '/auth/tokens/revoke', { method: 'POST', body: { id } }, io);
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
export async function relayOn(root, address, io, { session, quiet = false, strict = false } = {}) {
  const repository = originRepository(root);
  const file = linkFile(root);
  return locked(file, async () => {
    let state = loadLink(file);
    if (state) requireUnconflictedBaseline(state);
    if (state?.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish this device key cleanup with pullboard relay off before linking again');
    const url = relayOrigin(address || state?.url || DEFAULT_RELAY);
    if (state && (state.url !== url || state.repository !== repository)) throw new Refused('RELAY_LINKED', 'this board is linked to another relay or repository; run relay off before changing its link');
    const key = state ? readBoardKey(state.board) : await generateBoardKey();
    const signed = session ?? await deviceSignIn(url, io);
    if (session && session.url !== url) throw new Refused('RELAY_SESSION', 'Sign in again to this relay with pullboard relay on --all.');
    if (!state) {
      const snapshot = localRecords(root, (board) => {
        startRelayEpoch(board);
        return { board: store.boardId(board) };
      });
      snapshot.document = relaySnapshot(root);
      // Save the device key before creating any remote link; a locked keychain cannot strand it.
      const keyStorage = storeBoardKey(snapshot.board, key);
      state = { version: 1, mode: 'ordered', board: snapshot.board, url, repository, token: signed.token,
        tokenId: signed.id, keyStorage, presentationDigest: presentationDigest(snapshot.document.presentation), sequence: 0,
        cursor: snapshot.document.tables.event.at(-1)?.event_id ?? 0, baselineCursor: snapshot.document.tables.event.at(-1)?.event_id ?? 0,
        baselineAccepted: false, linkPending: true };
      state.snapshot = { sequence: 0, sealed: await sealedRecord(key, snapshot.document, state, 'snapshot', 0) };
    } else { state.token = signed.token; state.tokenId = signed.id; }
    state.account = signed.account ?? signed.user?.id;
    // Persist the exact sealed snapshot and a recoverable link intent before making the remote link.
    saveLink(file, state);
    if (state.linkPending) {
      await request(state, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository } }, io);
      delete state.linkPending;
      saveLink(file, state);
    }
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

/** Remove the remote board and its link before forgetting this device's private key and metadata. */
export async function relayOff(root, io) {
  updateRelayMachine(machine => { const project = repoInfo(root).root; if (!machine.excluded.includes(project)) machine.excluded.push(project); });
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) return summary(root, null);
    if (!state.unlinking) {
      const deleted = await request(state, '/api/v1/boards/' + state.board, { method: 'DELETE', allowMissing: true }, io);
      if (deleted.alreadyDeleted) state.alreadyDeleted = true;
      state.unlinking = true;
      saveLink(file, state);
    }
    forgetBoardKey(state.board, state.keyStorage);
    rmSync(file, { force: true });
    return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0,
      ...(state.alreadyDeleted ? { alreadyDeleted: true, notice: 'the relay had already deleted this board; this device is unlinked and the local board is complete' } : {}) };
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
    await relayDeviceRequest(state, '/api/v1/devices/' + device.deviceId, { method: 'POST', body: {} }, io);
    await relayDeviceRequest(state, '/api/v1/devices/' + device.deviceId + '/boards/' + state.board,
      { method: 'PUT', body: { engine: ENGINE_VERSION, wrapped: Buffer.from(JSON.stringify(wrapped)).toString('base64url') } }, io);
  }
}
