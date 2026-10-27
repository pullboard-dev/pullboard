import { orderedMoveCommand } from './relay-command-order.js';
import * as conflictRecords from './relay-conflict-record.js';
import { withRelayExclusion } from './relay-exclusion-state.js';
import { relinkReplacement } from './relay-relink.js';
import { relayExclusion } from './relay-exclusion-state.js';
import { excludeRelayByPerson } from './relay-exclusion-state.js';
import { clearRelayExclusion } from './relay-exclusion-state.js';
import { reportClearedExclusion } from './relay-exclusion-state.js';
import {
  cancellationOutcome,
  waitForDevicePoll,
} from './relay-device-poll.js';
import {
  formatSnapshotLimit,
  reportedSnapshotSize,
  snapshotSize,
} from './relay-snapshot-size.js';
export { formatSnapshotLimit, originRepository };
import { beginCommandPhase } from './command-phase.js';
import {
  recordClientHealth,
  readRelayHealth,
} from './relay-canary-health.js';
import { deliverPersonEnrollments } from './relay-person-enrollment.js';
import { recordedMoveRefusal } from './recorded-move.js';
import {
  publishExcludedBoards,
  publishOffExclusions,
} from './relay-excluded.js';
import {
  recoverySummary,
  recoveryRefusalMatches,
  unlinkedRelayStatus,
} from './relay-status-fields.js';
import { originRepository } from './github-origin.js';
import {
  clearUploadPauseNotices,
  firstUploadPauseNotice,
  permanentUploadRefusal,
  safePauseMessage,
  uploadPauseType,
  uploadRetryReady,
} from './relay-upload-pause.js';
/** Opt-in, sealed relay ordering, with crash-safe migration from the older mirror [H1,H3,H5,H16,H17,P5]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { SEALED_SNAPSHOT_BYTES as SEALED_SNAPSHOT_LIMIT } from './relay-limits.js';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import * as store from './board.js';
import {
  exportBoard,
  importBoard,
  restoreRelaySnapshot,
  semanticBoardDigest,
} from './exchange.js';
import {
  appliedSequence,
  applyEngineMove,
  applyRelayMove,
  checkpointSequence,
  engineReceipt,
  prepareEngineMove,
  refuseRelayMove,
  requireSupportedEngine,
  startRelayEpoch,
} from './engine.js';
import {
  credentialActor,
  operationIntent,
  relayMoveActor,
  relaySenderProblem,
} from './relay-sender.js';
import {
  actorTransport,
  ensurePersonCoordinator,
  seatReceipt,
  withSeatName,
} from './relay-seats.js';
import { syncApprovers } from './relay-approvers.js';
import { ENGINE_VERSION } from './machine.js';
import {
  presentationDigest,
  relayPresentation,
  relaySnapshot,
} from './relay-presentation.js';
import {
  codeIsFromMain,
  repoInfo,
  tryGit,
} from './git.js';
import {
  forgetBoardKey,
  readBoardKey,
  storeBoardKey,
} from './relay-key.js';
import {
  encodeBoardKey,
  generateBoardKey,
  seal,
  unseal,
} from './seal.js';
import { terminalQr } from './qr.js';
import { environmentLink } from './relay-environment.js';
import { locked } from './relay-lock.js';
import { withOutboxGuard } from './relay-outbox-guard.js';
import { relayOrdering } from './relay-ordering.js';
import { nudgeRelaySender } from './relay-local-first.js';
import { checkpointPublisher } from './relay-checkpoint-publish.js';
import {
  checkpointInBackground,
  requestCheckpointCheck,
  scheduleCheckpoint,
} from './relay-checkpoint.js';
import {
  decideUncertainBaseline,
  remoteBoardMissing,
  uncertainUploadFailure,
} from './relay-baseline-settle.js';
import {
  baselineNotAccepted,
  transientRelayFailure,
  transportFailure,
} from './relay-move-fallback.js';
import {
  ACKNOWLEDGED_OPERATIONS,
  flushOutbox,
  outboxFields,
  outboxFile,
  outboxHasPendingCreatedItem,
  outboxQueueable,
  readOutboxSummary,
  queueMove,
} from './relay-outbox.js';
import { stampCoordinatorHolder } from './coordinator-hold.js';
import { computerName } from './computer-name.js';
import { relayFiles } from './local-state.js';
import {
  archiveRelinkOutbox,
  finishRelink,
  plannedRelayBoard,
  relayRelink,
  rememberRelink,
} from './relay-relink.js';
import { Refused } from './refused.js';
import { landingRelayCallbacks } from './landing-relay.js';
import { relayOrigin } from './relay-origin.js';
import { readRelayLink } from './relay-link-read.js';
import { refusalFromReceipt } from './recorded-refusal.js';
import { relayNotices } from './relay-notices.js';
import {
  readRelayMachine,
  removeRecordedDevice,
  updateRelayMachine,
  wrapForRecordedDevice,
} from './relay-machine.js';
import {
  receivePersonRequest,
  requestMoveProblem,
} from './relay-requests.js';
import {
  nativePhoneAction,
  phoneProposal,
  publishPhoneApproval,
  warnPhoneApproval,
} from './relay-phone.js';
import {
  remoteShell as isRemoteShell,
  requirePersonChannel,
  requireRelayOnChannel,
} from './person.js';
import { listApiProjects } from './projects.js';
import {
  relaySnapshotRequest,
  relayStorage,
  relayStorageLine,
} from './relay-page-client.js';
export { relayOrigin, relayStorageLine };

export const DEFAULT_RELAY = 'https://app.pullboard.dev';
const LINK_FILES = new WeakMap();
const STATE_FILES = new WeakMap();
const MOVE_FALLBACK_NOTICES = new WeakSet();
const KEY_WARNED_COMMANDS = new WeakSet();
const BASELINE_ATTEMPTS = new WeakMap();
const BASELINE_NOTICES = new WeakSet();
const CHECKPOINT_NOTICES = new WeakMap();
const CHECKPOINT_MOVES = new WeakMap();
const BASELINE_FAILURES = new WeakMap();
const AUTH_NOTICES = new WeakSet();
const DELETION_NOTICES = new WeakSet();

/** Refuse a re-home that names an ID still owned by an unacknowledged local add. */
async function requireAuthoritativeRehomeItem(file, state, itemId) {
  if (!state || !Number.isSafeInteger(itemId) || itemId < 1 || !existsSync(outboxFile(file))) return;
  await withOutboxGuard(file, async () => {
    if (!existsSync(outboxFile(file))) return;
    if (await outboxHasPendingCreatedItem(outboxFile(file), readBoardKey(state.board), state.board, itemId)) {
      throw new Refused('RELAY_OUTBOX_UNBOUND', `item #${itemId} is still waiting for relay order; run pullboard status until it is sent, look up the current item ID, then retry the move`);
    }
  });
}

/** Check a selected team item before move-command destination reservation can choose another ID. */
export async function assertRehomeSourceItemOrdered(root, itemId, io) {
  const file = linkFile(root);
  await locked(file, async () => requireAuthoritativeRehomeItem(file, loadLink(file), itemId), io);
}
/** Find the shared local link metadata without opening a board or connecting for an unlinked repo. */
function linkFile(root) { return relayFiles(repoInfo(root).commonDir).link; }

/** Locate the credential-free reason an independently deleted copy no longer syncs. */
function deletedLinkFile(root) { return relayFiles(repoInfo(root).commonDir).deleted; }

/** Read only a private, bounded deletion marker; it never supplies credentials or an outbound destination. */
function deletedLink(root) {
  const file = deletedLinkFile(root);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096) throw new Refused('RELAY_STORAGE', 'restore the private deleted-copy notice before reading relay status');
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Refused('RELAY_STORAGE', 'restore the private deleted-copy notice before reading relay status'); }
  if (value?.version !== 1 || !/^[0-9a-f]{32}$/u.test(value.board ?? '') || typeof value.url !== 'string') throw new Refused('RELAY_STORAGE', 'restore the supported deleted-copy notice before reading relay status');
  relayOrigin(value.url);
  const recovered = value.recovered;
  if (recovered !== undefined && (!recovered || !/^[A-Za-z0-9_-]{1,80}$/u.test(recovered.id ?? '')
      || !/^[0-9a-f]{64}$/u.test(recovered.intent ?? '')
      || (recovered.commandIntent !== undefined && !/^[0-9a-f]{64}$/u.test(recovered.commandIntent)))) {
    throw new Refused('RELAY_STORAGE', 'restore the private interrupted-move receipt pointer before retrying');
  }
  return value;
}

/** Accept deletion only from the configured versioned relay for this credential's own board. */
function confirmedDeletion(state, error) {
  return error instanceof Refused && error.httpStatus === 410 && error.relayVersion === 1
    && error.relayCode === 'RELAY_BOARD_DELETED' && error.relayMessage?.startsWith(`relay copy ${state.board} was deleted;`);
}

/** Atomically persist a private notice and its optional key-free native receipt pointer. */
function saveDeletedLink(root, value) {
  const marker = deletedLinkFile(root);
  const temporary = marker + '.' + randomUUID() + '.tmp';
  const encoded = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(encoded) > 4096) throw new Refused('RELAY_STORAGE', 'restore a bounded deleted-copy notice before retrying');
  try {
    writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, marker);
  } finally { rmSync(temporary, { force: true }); }
}

/** Compare an interrupted intent without retaining command arguments or credentials in the notice. */
function intentDigest(intent) { return createHash('sha256').update(intent).digest('hex'); }

/** Commit the sender's pending native obligation before any link metadata or key can be removed. */
function retainDeletedMove(root, state) {
  const recovered = state.pending ?? state.recovered;
  if (!recovered) return null;
  const move = recovered.move;
  if (!move || typeof move.id !== 'string') throw new Refused('RELAY_STORAGE', 'restore the interrupted move before forgetting the deleted copy');
  const intent = recovered.intent ?? operationIntent(move.operation, move.args);
  if (typeof intent !== 'string' || recovered.commandIntent !== undefined
      && recovered.commandIntent !== operationIntent('cli:' + recovered.command?.cliOperation, recovered.command)) {
    throw new Refused('RELAY_STORAGE', 'restore the interrupted command metadata before retrying');
  }
  localRecords(root, board => {
    const receipt = engineReceipt(board, move.id);
    if (receipt) {
      if (receipt.move !== JSON.stringify(move)) throw new Refused('RELAY_MOVE', 'restore the interrupted move that matches its durable receipt before retrying');
      return; // A crash after the receipt must not advance the native cursor again.
    }
    applyEngineMove(board, move, { sequence: appliedSequence(board) + 1, at: board.clock.now().toISOString() });
  });
  return { id: move.id, intent: intentDigest(intent),
    ...(recovered.commandIntent === undefined ? {} : { commandIntent: intentDigest(recovered.commandIntent) }) };
}

/** Resolve the private pointer only through the exact durable native receipt, never a remote key. */
function deletedRecovery(root) {
  const marker = deletedLink(root);
  if (!marker?.recovered) return null;
  const receipt = localRecords(root, board => engineReceipt(board, marker.recovered.id));
  let move;
  try { move = receipt && JSON.parse(receipt.move); } catch { /* Refuse a corrupt receipt below. */ }
  if (!move || move.id !== marker.recovered.id || !receipt.outcome) {
    throw new Refused('RELAY_STORAGE', 'restore the interrupted native receipt before retrying its command');
  }
  return { marker, receipt, move };
}

/** Consume only the reported receipt, preserving the truthful deleted-copy notice. */
function clearDeletedRecovery(root, marker) {
  delete marker.recovered;
  saveDeletedLink(root, marker);
}

/** Return an exact interrupted result once; a different command can continue beside the saved move. */
function deletedMoveResult(root, operation, args, command, io, applyLocally) {
  const recovered = deletedRecovery(root);
  const pointer = recovered?.marker.recovered;
  const matches = pointer && (pointer.commandIntent === undefined
    ? pointer.intent === intentDigest(operationIntent(operation, args))
    : recovered.move.operation === operation && pointer.commandIntent === intentDigest(operationIntent('cli:' + command?.cliOperation, command)));
  if (!matches) return applyLocally();
  clearDeletedRecovery(root, recovered.marker);
  if (recovered.receipt.outcome.error) throw refusalFromReceipt(recovered.receipt.outcome.error);
  for (const event of recovered.receipt.outcome.events ?? []) io.onEvent?.(event);
  return recovered.receipt.outcome.result;
}

/** Preserve the pending native move and a truthful notice before removing the inert link. */
function forgetDeletedCopy(root, file, state, io) {
  const recovered = retainDeletedMove(root, state);
  saveDeletedLink(root, { version: 1, board: state.board, url: state.url, ...(recovered ? { recovered } : {}) });
  rememberRelink(root, state.board);
  archiveRelinkOutbox(root, state);
  rmSync(file, { force: true });
  try { forgetBoardKey(state.board, state.keyStorage); } catch { /* An unavailable key store cannot block completed local opt-out. */ }
  if (!DELETION_NOTICES.has(io)) {
    DELETION_NOTICES.add(io);
    io.err(`pullboard: [RELAY_BOARD_DELETED] relay copy ${state.board} was deleted; local work continues; run pullboard relay on for fresh person approval to link it again`);
  }
}

/** Validate private link metadata before trusting its destination or acknowledgement cursor. */
function loadLink(file) {
  const state = readRelayLink(file);
  if (!state) return null;
  if (state.token === undefined || state.token?.startsWith('ps_')) {
    state.token = null;
    delete state.tokenId;
    state.personReauth = true;
    saveLink(file, state);
  }
  STATE_FILES.set(state, file);
  // A move queues itself without the relay lock, so the outbox summary lives in its own file (#1013).
  const waiting = readOutboxSummary(file);
  if (waiting) state.outbox = waiting;
  else if (!existsSync(outboxFile(file))) delete state.outbox;
  return state;
}

/** Atomically persist acknowledgements and an exact sealed retry before attempting its send. */
export function saveLink(file, state) {
  STATE_FILES.set(state, file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    // The outbox summary is the outbox's own file; a link saved by the sender never overwrites a move's (#1013).
    writeFileSync(temporary, JSON.stringify({ ...state, outbox: undefined }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Use the page adapter only for snapshot requests; the saved opt-in still owns every network call. */
export async function request(state, path, options = {}, io) {
  return relaySnapshotRequest(state, path, options, io, {
    raw: (target, settings) => rawRequest(state, target, settings, io), key: () => readBoardKey(state.board),
    decode: (record, key) => decoded(key, record, state, 'snapshot', record.sequence),
    encode: (value, sequence, key) => sealedRecord(key, value, state, 'snapshot', sequence),
    maxEngine: ENGINE_VERSION, legacyLimit: SEALED_SNAPSHOT_LIMIT,
    persist: () => { const file = STATE_FILES.get(state); if (file) saveLink(file, state); },
  });
}

/** The sole raw HTTP transport: explicit sign-in or a saved, opted-in board link, with bounded deadlines. */
async function rawRequest(state, path, { method = 'GET', body, allowMissing = false, initialBaseline = false, signal } = {}, io) {
  signal ??= io?.relaySignal;
  io?.onRelayRequest?.({ method, path });
  const supplied = io?.ignoreRelayEnvironmentToken ? undefined : process.env.PULLBOARD_RELAY_TOKEN;
  const readToken = method === 'GET' && /^\/api\/v[12]\/boards\//u.test(path) ? supplied : undefined;
  if (readToken !== undefined && !/^pa_[A-Za-z0-9_-]{43}$/.test(readToken)) throw new Refused('AUTH_REQUIRED', 'supply a current scoped board token without including it in command arguments');
  const token = readToken ?? state.token;
  let response;
  // Validate first: a refusal below repeats this address, so it must already be credential-free.
  const origin = relayOrigin(state.url);
  const startedAt = Date.now();
  const finishPhase = beginCommandPhase('waiting-relay');
  try {
    let requestSignal;
    for (let attempt = 0; ; attempt += 1) {
      try {
        requestSignal ??= signal ? AbortSignal.any([signal, AbortSignal.timeout(io?.relayTimeoutMs ?? 10000)]) : AbortSignal.timeout(io?.relayTimeoutMs ?? 10000); // budget: original per-request transport ceiling, shared by a replacement GET.
        response = await fetch(origin + path, {
          method, redirect: 'error', signal: requestSignal,
          headers: { 'x-pullboard-engine': String(ENGINE_VERSION), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(initialBaseline ? { 'if-none-match': '*' } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        break;
      } catch (error) {
        if (signal?.aborted) throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
        // A stale cached connection reports ECONNRESET or EPIPE across supported Node runtimes. Only a read may try once more.
        if (method === 'GET' && attempt === 0 && ['ECONNRESET', 'EPIPE'].includes(transportFailure(error)) && requestSignal && !requestSignal.aborted) continue;
        const refusal = new Refused('RELAY_UNAVAILABLE', `the relay ${state.url} did not answer (${transportFailure(error)} after ${Date.now() - startedAt} ms on ${method} ${path.split('?')[0]}); read the local board offline, then retry this move when the relay is reachable`);
        refusal.transportFailure = transportFailure(error);
        throw refusal;
      }
    }
    let document;
    try { document = await response.json(); }
    catch {
      if (signal?.aborted) throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
      const error = new Refused('RELAY_RESPONSE', 'the relay returned an invalid response; retry with the configured relay address');
      error.httpStatus = response.status;
      throw error;
    }
    relayNotices(document, io);
    // Only off can forget a link after a supported API reports that the board is gone.
    if (allowMissing && method === 'DELETE' && response.status === 404 && document.version === 1) return { alreadyDeleted: true };
    if (!response.ok) {
      const error = new Refused(document.error?.code || 'RELAY_UNAVAILABLE', (document.error?.code === 'AUTH_REQUIRED' ? ((state.agent || token?.startsWith('pa_')) ? 'this agent token is expired or revoked; use a new token issued by the person for this agent, then retry with PULLBOARD_RELAY_TOKEN' : 'the relay sign-in expired or was revoked; run pullboard relay on to sign in again without changing the board key') : (document.error?.message ? `the relay ${state.url}: ${document.error.message}` : null)) || 'the relay refused this send; retry this command explicitly when reachable',
        document.error?.code === 'AUTH_REQUIRED' ? undefined : document.error?.next);
      error.httpStatus = response.status;
      error.relayVersion = document.version;
      error.relayCode = document.error?.code;
      error.relayMessage = document.error?.message;
      if (document.version === 1 && document.error?.code === 'BAD_UPLOAD') error.snapshotLimit = document.error.snapshotLimit;
      if (/^[0-9a-f]{64}$/u.test(document.error?.page ?? '')) error.page = document.error.page;
      const storage = relayStorage(document.error?.storage);
      if (storage) error.storage = storage;
      throw error;
    }
    if (document.version !== 1) throw Object.assign(new Refused('RELAY_VERSION', 'the relay API version is unsupported; upgrade Pullboard before syncing'),
      Number.isSafeInteger(document.version) ? { relayVersion: document.version } : {});
    return document;
  } finally { finishPhase(); }
}

/** Read durable local event rows; their ids are the crash-safe outbox after the saved cursor. */
export function localRecords(root, work) {
  const info = repoInfo(root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain(), gitRoot: root });
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Fingerprint native board contents so async recovery can refuse concurrent local writes. */
function nativeBoardDigest(board) {
  return semanticBoardDigest(exportBoard(board));
}

/** Count unapplied uploads using durable event ids, without counting relay transport metadata. */
function behind(root, state) {
  return localRecords(root, (board) => board.db.prepare('SELECT COUNT(*) AS count FROM event WHERE event_id > ?').get(state.cursor).count);
}

/** Expose key-free link status; only an explicit link operation includes its pairing carrier. */
function summary(root, state, { pairing = false } = {}) {
  if (!state) {
    const deleted = deletedLink(root);
    const exclusion = relayExclusion(root);
    return { ...unlinkedRelayStatus(deleted), ...(exclusion ? { excluded: true, exclusion } : {}) };
  }
  if (state.unlinking) return { linked: false, board: state.board, url: state.url, link: '', sequence: state.sequence, behind: 0, cleanup: true, recovery: recoverySummary(state) };
  const fragment = pairing ? '&key=' + encodeBoardKey(readBoardKey(state.board)) : '';
  const oversizedSnapshot = snapshotSize(state);
  return { linked: true, board: state.board, url: state.url, account: state.account ?? '', login: state.login ?? '',
    link: 'https://app.pullboard.dev/#board=' + state.board + fragment,
    sequence: state.sequence, behind: (state.baselinePause ? behind(root, state) : state.mode === 'ordered' ? Number(Boolean(state.pending)) : behind(root, state)) + Number(Boolean(state.snapshot || state.checkpoint))
      + (state.outbox?.moves?.length ?? 0),
    recovery: recoverySummary(state),
    health: readRelayHealth(root, { queued: state.outbox?.moves?.length ?? 0 }),
    ...outboxFields(state),
    ...(relayStorage(state.storage) ? { storage: relayStorage(state.storage) } : {}),
    ...(oversizedSnapshot ? { oversizedSnapshot } : {}),
    ...(state.baselinePause ? { pausedUpload: structuredClone(state.baselinePause) } : {}),
    ...(state.checkpointRefusal ? { refusedCheckpoint: checkpointProblem(state) } : {}) };
}

/** Publish only an actually received, measured refusal, sealed to the existing board key. */
async function publishSnapshotSize(state, io) {
  const pause = state.baselinePause;
  if (!pause?.reportedSize || pause.sizeNoticePublished) return;
  const value = { version: 1, kind: 'snapshot-size-refusal', board: state.board, engine: ENGINE_VERSION, ...pause.size };
  try {
    const sealed = Buffer.from(await seal(readBoardKey(state.board), new TextEncoder().encode(JSON.stringify(value)),
      { boardId: state.board, kind: 'snapshot', sequence: 0 })).toString('base64url');
    const reply = await rawRequest(state, '/api/v1/boards/' + state.board + '/upload-status', { method: 'PUT', body: { sealed } }, io);
    if (typeof reply.recorded !== 'boolean') throw new Refused('RELAY_RESPONSE', 'Retry the sealed size notice when the relay can acknowledge it.');
    pause.sizeNoticePublished = true;
    const file = STATE_FILES.get(state);
    if (file) saveLink(file, state);
  } catch { io.err('The board is paused locally; its sealed size notice could not reach the relay. Retry when the relay is reachable.'); }
}

/** Return the local pending snapshot's oversize details without contacting the relay. */
export function pendingSnapshotSize(root) {
  return snapshotSize(loadLink(linkFile(root)));
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

/** Explain a refused later checkpoint without changing the ordered-move recovery policy. */
function checkpointProblem(state) {
  const refusal = state.checkpointRefusal;
  const code = safePauseCode(refusal);
  const reason = safePauseMessage(refusal);
  const size = snapshotSize(state);
  if (refusal.code === 'ACCOUNT_STORAGE_LIMIT') return { code: refusal.code,
    message: `relay checkpoint paused for ${state.board}: ${relayStorageLine(state.storage)}; free relay storage or ask the operator to raise the quota; moves still sync in order`,
    next: 'Free relay storage or ask the operator to raise the account quota; uploads resume automatically.' };
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

/** Share one notice across a native command and its bookkeeping, or one direct ordered move. */
function reportCheckpointRefusal(state, io) {
  let boards = CHECKPOINT_NOTICES.get(io.relayCommand ?? io);
  if (!boards) { boards = new Set(); CHECKPOINT_NOTICES.set(io.relayCommand ?? io, boards); }
  if (boards.has(state.board)) return;
  boards.add(state.board);
  if (uploadPauseType(state.checkpointRefusal) && !firstUploadPauseNotice(state)) return;
  const line = 'pullboard: ' + checkpointProblem(state).message;
  if (['status', 'doctor'].includes(io.relayCommand?.cliOperation) && io.relayJson === false) io.say(line);
  else io.err(line);
}

/** Name the safe next step for the saved permanent refusal. */
function pauseFix(state) {
  const pause = state.baselinePause;
  if (pause.size || /(?:exceeds?|over|larger than|too large).{0,40}(?:bytes|snapshot|limit)|(?:snapshot|limit).{0,40}(?:exceeds?|over|too large)/iu.test(pause.message)) {
    return 'upgrade the configured relay to API version 2 for bounded snapshots, then it resumes automatically';
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
    if (firstUploadPauseNotice(state)) io.err(baselinePauseLine(state));
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
    if (remoteBoardMissing(error)) return true;
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
  delete state.baselineUncertain;
  saveLink(file, state);
  requireUnconflictedBaseline(state);
}

/** Fence another device's baseline before a retry can replace its sequence-zero snapshot. */
async function requireAbsentBaseline(file, state, io) {
  if (!await remoteBaselineAbsent(state, io)) {
    fenceBaseline(file, state);
  }
}

/** Record that the relay holds the pending sequence-zero snapshot, from its ACK or an authenticated read of it. */
function acceptBaseline(root, file, state) {
  state.baselineAccepted = true;
  state.cursor = Number.isSafeInteger(state.baselineCursor) ? state.baselineCursor : localRecords(root, (board) => board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
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
function decideBaseline(root, file, state, io) {
  return decideUncertainBaseline(state, io, { read: () => request(state, '/api/v1/boards/' + state.board + '/state', {}, io),
    accept: () => acceptBaseline(root, file, state), fence: () => fenceBaseline(file, state),
    save: () => saveLink(file, state), remember: (error) => rememberBaselineFailure(io, file, error) });
}

/** Send the sequence-zero board image; only its first permanent HTTP refusal pauses relay sends. */
async function uploadInitialBaseline(root, file, state, io) {
  attemptedBaselineThisCommand(io, file);
  let sent = false;
  try {
    await requireAbsentBaseline(file, state, io);
    const pending = state.snapshot;
    // Written ahead: from here until a definite answer, the relay may hold this snapshot (#919).
    state.baselineUncertain = sent = true;
    saveLink(file, state);
    const reply = await request(state, '/api/v1/boards/' + state.board + '/state', { method: 'PUT', body: pending, initialBaseline: true }, io);
    if (reply.state?.sequence !== pending.sequence || reply.state.sealed !== pending.sealed) throw new Refused('RELAY_RESPONSE', 'the relay did not acknowledge the initial snapshot; retry the configured relay');
    acceptBaseline(root, file, state);
    return true;
  } catch (error) {
    if (sent && state.baselineUncertain && uncertainUploadFailure(error)) {
      if (await decideBaseline(root, file, state, io)) return true;
    } else if (sent && state.baselineUncertain) { delete state.baselineUncertain; saveLink(file, state); }
    if (error.relayVersion === 1 && error.code === 'BASELINE_EXISTS') fenceBaseline(file, state);
    if (!permanentUploadRefusal(error) || state.baselineAccepted) {
      rememberBaselineFailure(io, file, error);
      throw error;
    }
    try {
      await requireAbsentBaseline(file, state, io);
    } catch (uncertain) {
      rememberBaselineFailure(io, file, uncertain);
      throw uncertain;
    }
    const reported = reportedSnapshotSize(error, state);
    const size = reported ?? pendingSnapshotSize(root);
    state.baselinePause = {
      status: error.httpStatus,
      code: safePauseCode(error),
      message: safePauseMessage(error),
      ...(size ? { size: { sealedBytes: size.sealedBytes, limit: size.limit } } : {}),
      ...(reported ? { reportedSize: true } : {}),
    };
    // Retain the refused ciphertext and its source cursor; blocked commands do not re-seal it.
    saveLink(file, state);
    await publishSnapshotSize(state, io);
    reportBaselinePause(state, io);
    return false;
  }
}

/** Probe blocked limits first; only a recovered relay receives a fresh baseline containing all paused local moves. */
async function retryPausedBaseline(root, file, state, io) {
  if (!(state.baselinePause || state.baselineStale) || attemptedBaselineThisCommand(io, file)) return !(state.baselinePause || state.baselineStale);
  try {
    if (!await uploadRetryReady(state, state.baselinePause, path => request(state, path, {}, io))) {
      await publishSnapshotSize(state, io);
      saveLink(file, state); reportBaselinePause(state, io); return false;
    }
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

/** Read validated View eligibility without decoding snapshots, opening a board or contacting the relay. */
export function relayLinkAvailability(root) {
  const state = loadLink(linkFile(root));
  return { linked: Boolean(state && !state.unlinking), unlinking: Boolean(state?.unlinking) };
}

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
    return conflictRecords.replay(board, move, record, applyRelayMove);
  } catch (error) { // A seal no key opens, from an engine no newer than this one, is junk: set aside, never a stop [E20].
    if (!(error instanceof Refused) || !(['RELAY_MOVE', 'RELAY_RESPONSE', 'SEAL_FORMAT', 'SEAL_AUTH_FAILED'].includes(error.code) || error.code === 'SEAL_VERSION' && record.sender?.engine <= ENGINE_VERSION)) throw error;
    return refuseRelayMove(board, move, { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind, code: ['SEAL_AUTH_FAILED', 'SEAL_VERSION'].includes(error.code) ? 'RELAY_SEAL' : error.code,
      digest: createHash('sha256').update(String(record.sealed)).digest('hex'),
      refusal: ['SEAL_AUTH_FAILED', 'SEAL_VERSION'].includes(error.code)
        ? new Refused('RELAY_SEAL', 'this relay record failed authentication and was logged as refused; run pullboard relay to continue with the next ordered record')
        : error });
  }
}

// Checkpoint publishing lives in its own module, over these link and transport helpers (#1014).
const checkpoints = checkpointPublisher({ request, saveLink, loadLink, linkFile, readBoardKey, sealedRecord, reportCheckpointRefusal, safePauseCode, safePauseMessage });
const publishCheckpoint = (...args) => checkpoints.publishCheckpoint(...args);
/** Publish this board's checkpoint once, as the background publisher's one step (#1014). */
export const publishLatestCheckpoint = (...args) => checkpoints.publishLatestCheckpoint(...args);

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
    // An earlier command lost the reply to its first upload: decide it before re-sealing or sending anything.
    if (state.baselineUncertain && !state.baselineAccepted) await decideBaseline(root, file, state, io);
    if (state.baselinePause || state.baselineStale) {
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
export async function restoreCheckpoint(root, state, io, key, restore = restoreRelaySnapshot) {
  const document = await request(state, '/api/v1/boards/' + state.board + '/state', {}, io);
  const snapshot = document.state;
  if (!snapshot || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Refused('RELAY_RESPONSE', 'the relay snapshot has no valid coverage sequence; fetch it again');
  const senderProblem = relaySenderProblem(null, snapshot.sender, 'snapshot');
  if (senderProblem) throw senderProblem;
  const native = await decoded(key, snapshot, state, 'snapshot', snapshot.sequence);
  localRecords(root, (board) => restore(board, native, snapshot.sequence));
}

/**
 * Keep why a move's reply was lost on its durable send record, then return the original refusal.
 * Why: the command that gave up exits here, so only the saved cause lets whichever later command
 * recovers the move say what the earlier request failed with (#642). It holds the cause name only.
 */
function rememberLostReply(file, state, id, error) {
  const held = [state.pending, state.recovered].find((record) => record?.move?.id === id);
  if (held) {
    held.lostReply = error.transportFailure ?? error.code;
    saveLink(file, state);
  }
  return error;
}

/**
 * Say once that catch-up recovered a move whose earlier reply was lost, with that request's cause.
 * Why: any later command, a read included, may be the one that recovers it; the saved cause is
 * cleared here so the repeated command does not say it again (#642).
 */
function reportRecoveredReply(record, io) {
  if (!record?.lostReply) return;
  io?.err?.(`pullboard: recovered move ${record.sequence} (${record.move.operation}) whose earlier reply was lost: ${record.lostReply}`);
  delete record.lostReply;
}

// Catch-up and send live in their own module, over these link and transport helpers (#1013).
const ordering = relayOrdering({ request, localRecords, decoded, replayRelayRecord, reportRecoveredReply, saveLink, sealedRecord,
  flush: (root, file, state, io) => flushOutbox(outboxLink(root, file, state, io)) });
const { applyRecords, fetchCheckpoint, catchUp, postPending, sendPending } = ordering;

/** Set up this machine's coordinator token inside a paired join's own person sign-in (#579). */
export async function relayPersonCoordinator(root, session, io) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (state && /^ps_[A-Za-z0-9_-]{43}$/u.test(session ?? '')) await ensurePersonCoordinator(file, state, session, io);
  });
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

/**
 * Record that a local move happened while the baseline upload was uncertain, and say so once.
 * Why: the saved snapshot predates the move, so the next command seals a fresh baseline that holds it (#919).
 */
function keepMoveForLaterBaseline(file, state, error, io) {
  state.baselineStale = true;
  saveLink(file, state);
  if (MOVE_FALLBACK_NOTICES.has(io)) return;
  MOVE_FALLBACK_NOTICES.add(io);
  io.err(`pullboard: [${safePauseCode(error)}] the move is saved on this machine; ${error.transportFailure ? `the relay did not answer (${error.transportFailure})` : safePauseMessage(error)}; it goes up inside the board baseline on a later command once the relay answers`);
}

/** The relay transport the ordered outbox queues and replays through (#922). */
function outboxLink(root, file, state, io) {
  return { root, file, state, io, request, sealedRecord, localRecords, saveLink, safePauseCode, safePauseMessage,
    applyRecords, fetchCheckpoint: (key) => fetchCheckpoint(state, io, key), postPending };
}

/**
 * The link a move may queue on and return at once (#1013), or null when it must reach the relay first: the board's
 * relay.outbox is on and the relay accepted its baseline, and the move needs no relay answer to exist (a
 * registration mints its token there, a takeover needs the relay's sign-in lineage, a person's request is the
 * phone's, and landing authority needs real order). Environment-token sessions always wait: ephemeral jobs
 * cannot retain queued moves after they exit.
 */
function localFirstLink(file, operation, args, io) {
  let state;
  try { state = loadLink(file); } catch { return null; }
  if (!state || state.unlinking || state.recovery || state.mode !== 'ordered' || state.baselineAccepted !== true
    || state.baselineConflict || state.baselinePause || state.baselineStale || state.environment) return null;
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined || io?.relayCanary || io?.personRequest || io?.personRequestMoveId) return null;
  // A takeover needs the relay's authenticated sign-in lineage, which only the relay's order carries.
  if (ACKNOWLEDGED_OPERATIONS.includes(operation) || args?.[0]?.landingFence !== undefined) return null;
  if (credentialActor({ operation, args }) === 'person') return null;
  try { if (io?.relayOutbox?.() !== true) return null; } catch { return null; }
  return state;
}

/**
 * Make a move on this machine at once and queue it for the relay (#1013): no network call and no relay lock, only
 * the short outbox guard. The background sender sends it and rebuilds the board once the relay has ordered it.
 */
async function queueLocally(root, file, operation, args, io, command, applyLocally, onRecorded) {
  const guarded = landingRelayCallbacks(operation, args, {
    apply: () => typeof applyLocally === 'function' ? applyLocally() : localRecords(root, (board) => store[operation](board, ...args)),
    queue: () => { throw new Refused('RELAY_OUTBOX', 'a local-first move queues itself; it is never queued twice'); },
  });
  // An unlink that finished while this move waited for the guard leaves an ordinary local board.
  const result = await withOutboxGuard(file, () => {
    // A revoke can finish while this move waits: admission uses the cache protected by this guard, never its earlier snapshot.
    const current = loadLink(file);
    return !current ? guarded.apply() : queueMove(outboxLink(root, file, current, io),
      { operation, args, command, applyLocally: guarded.apply, quiet: true });
  });
  onRecorded?.();
  nudgeRelaySender(root, file);
  return result;
}

/** Send one board operation before executing it locally, and report its canonical engine result. */
export async function relayOperation(root, operation, args, io, command, applyLocally, onRecorded) {
  const roundTripStarted = Date.now();
  const file = linkFile(root);
  const local = localFirstLink(file, operation, args, io);
  if (local) return queueLocally(root, file, operation, args, io, command, applyLocally, onRecorded);
  return locked(file, async () => {
    const state = loadLink(file);
    if (operation === 'rehomeItem') await requireAuthoritativeRehomeItem(file, state, args?.[0]);
    const guarded = landingRelayCallbacks(operation, args, {
      apply: () => typeof applyLocally === 'function' ? applyLocally() : localRecords(root, (board) => store[operation](board, ...args)),
      queue: (error, move, apply) => queueMove(outboxLink(root, file, state, io), { operation, args, command, move, error, applyLocally: apply }),
    });
    const applyPausedMoveLocally = guarded.apply;
    if (!state && deletedRecovery(root)) return deletedMoveResult(root, operation, args, command, io, applyPausedMoveLocally);
    if (!state || state.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish unlinking this device with pullboard relay off before sending a move');
    if (state.recovery) throw new Refused('RELAY_RECOVERY_PENDING', `finish the saved recovery for sequence ${state.recovery.skip} before sending a linked move`);
    if (credentialActor({ operation, args, personRequest: io?.personRequest }) === 'person') {
      throw new Refused('HUMAN_REQUIRED', 'send this person action from the paired phone');
    }
    let moves = CHECKPOINT_MOVES.get(io);
    if (!moves) { moves = new Set(); CHECKPOINT_MOVES.set(io, moves); }
    if (!io.relayCommand && moves.has(state.board)) CHECKPOINT_NOTICES.get(io)?.delete(state.board);
    moves.add(state.board);
    let requestedMove;
    try {
      const requiresAcknowledgment = process.env.PULLBOARD_RELAY_TOKEN !== undefined || state.environment || io.relayCanary;
      let ordered;
      const queue = guarded.queue;
      try { ordered = await ensureOrdered(root, file, state, io); }
      catch (error) {
        if (outboxQueueable(state, error, operation, io, args)) return await queue(error);
        // #341/#919 retain persistent local moves; ephemeral sessions and canaries always require acknowledgment.
        if (requiresAcknowledgment || !baselineNotAccepted(state) || !transientRelayFailure(error)) throw error;
        keepMoveForLaterBaseline(file, state, error, io);
        ordered = false;
      }
      if (!ordered) {
        if (requiresAcknowledgment) throw new Refused('RELAY_UNAVAILABLE', 'this session requires a relay acknowledgment; retry the move when the relay accepts the board baseline');
        if (state.baselinePause) reportBaselinePause(state, io);
        return applyPausedMoveLocally();
      }
      try {
        // #922: moves queued while the relay was down go up first, in the order they were made.
        await flushOutbox(outboxLink(root, file, state, io));
        await catchUp(root, file, state, io);
      } catch (error) {
        if (outboxQueueable(state, error, operation, io, args)) return await queue(error);
        throw error;
      }
      if (state.pending) {
        delete state.pending;
        saveLink(file, state);
      }
      const previousReceipt = io.personRequestMoveId && localRecords(root, board => engineReceipt(board, io.personRequestMoveId));
      if (previousReceipt) {
        if (!previousReceipt.outcome.error) onRecorded?.();
        if (state.recovered?.move?.id === io.personRequestMoveId) {
          delete state.recovered;
          saveLink(file, state);
        }
        if (previousReceipt.outcome.error) throw refusalFromReceipt(previousReceipt.outcome.error);
        for (const event of previousReceipt.outcome.events ?? []) io.onEvent?.(event);
        return previousReceipt.outcome.result;
      }
      let move = recoveredMove(root, state, operation, args, command);
      requestedMove = move;
      try {
        if (!move) {
          const sent = withSeatName(root, operation, args);
          move = stampCoordinatorHolder(localRecords(root, (board) => prepareEngineMove(board, operation, sent,
            io.personRequestMoveId ? { id: io.personRequestMoveId } : operation === 'rehomeItem' && io.rehomeMoveId ? { id: io.rehomeMoveId } : {})), state.machine, state.computerName);
          requestedMove = move;
          if (io.personRequest) move.personRequest = structuredClone(io.personRequest);
          const problem = move.personRequest && localRecords(root, board => requestMoveProblem(board, move, { checkExecutorLease: false }));
          if (problem) throw problem;
          move.actor = relayMoveActor(move) ?? credentialActor(move);
          await actorTransport(root, file, state, credentialActor(move), io);
          const sequence = state.sequence + 1;
          const sealed = await sealedRecord(readBoardKey(state.board), move, state, 'move', sequence);
          const registration = seatReceipt(move, sequence, sealed);
          state.pending = { move, intent: operationIntent(operation, args),
            ...(command ? { command, commandIntent: operationIntent('cli:' + command.cliOperation, command) } : {}), sequence,
            sealed, ...(registration ? { registration } : {}) };
          saveLink(file, state);
          try { await sendPending(root, file, state, io); }
          catch (error) {
            if (!['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(error.code)) throw error;
            // A lost acknowledgement can be recovered now without asking the caller to retry side effects.
            try { await catchUp(root, file, state, io); } catch { throw rememberLostReply(file, state, move.id, error); }
            if (!localRecords(root, (board) => engineReceipt(board, move.id))) throw rememberLostReply(file, state, move.id, error);
          }
        }
      } catch (error) {
        // #922: on an accepted link, a relay that stays down queues the move; a lost reply's copy is matched at replay.
        if (move && !localRecords(root, (board) => engineReceipt(board, move.id)) && outboxQueueable(state, error, operation, io, args)) return await queue(error, move);
        throw error;
      }
      const receipt = localRecords(root, (board) => engineReceipt(board, move.id));
      if (!receipt) throw new Refused('RELAY_RESPONSE', 'the acknowledged operation has no replay receipt; fetch a consistent relay snapshot');
      if (!receipt.outcome.error) {
        onRecorded?.();
        await io.onRelayMoveRecorded?.({ moveId: move.id, sequence: receipt.sequence });
        if (!io.relayCanary) recordClientHealth(root, true, null, Date.now() - roundTripStarted);
      }
      delete state.recovered;
      saveLink(file, state);
      // A phone reads the next checkpoint; the background publisher sends it once moves go quiet (#1014).
      if (checkpointInBackground()) scheduleCheckpoint(root, file);
      else {
        // A phone can read a compacted checkpoint; failed presentation uploads do not undo the move.
        try { await publishCheckpoint(root, file, state, io); }
        catch (error) {
          if (!(error instanceof Refused)) throw error;
          if (confirmedDeletion(state, error)) forgetDeletedCopy(root, file, state, io);
          else if (error.code === 'AUTH_REQUIRED') {
            if (!receipt.outcome.error) io.err(`pullboard: ${recordedMoveRefusal({ recordedMove: true }, error).message}`);
            reportExpiredSignIn(state, io);
          } else io.err(`pullboard: ${recordedMoveRefusal({ recordedMove: !receipt.outcome.error }, error).message}`);
        }
      }
      if (receipt.outcome.error) throw refusalFromReceipt(receipt.outcome.error);
      if (existsSync(file) && ['register', 'ensureCoordinator'].includes(operation)) await actorTransport(root, file, state, receipt.outcome.result, io);
      for (const event of receipt.outcome.events ?? []) io.onEvent?.(event);
      return receipt.outcome.result;
    } catch (error) {
      // Catch-up may commit the requested receipt before a later link write refuses. A refused receipt counts as nothing.
      if (!io.relayCanary) recordClientHealth(root, false, error, Date.now() - roundTripStarted);
      if (requestedMove && onRecorded) {
        try {
          const committed = localRecords(root, board => engineReceipt(board, requestedMove.id));
          if (committed && !committed.outcome.error) onRecorded();
        } catch { /* No readable durable receipt means no recorded-outcome claim. */ }
      }
      if (confirmedDeletion(state, error)) {
        forgetDeletedCopy(root, file, state, io);
        return deletedMoveResult(root, operation, args, command, io, applyPausedMoveLocally);
      }
      if (error instanceof Refused && error.code === 'AUTH_REQUIRED') throw expiredSignInMoveRefusal(state, error);
      throw error;
    }
  }, io);
}

/** Catch up an opted-in replica before/after a CLI command; offline reads retain local evidence. */
export async function syncRelay(root, io) {
  const roundTripStarted = Date.now();
  // Reuse Git discovery only within this command; still re-read the link before each retry.
  const files = LINK_FILES.get(io) ?? LINK_FILES.set(io, new Map()).get(io);
  const file = files.get(root) ?? linkFile(root);
  files.set(root, file);
  if (!await environmentLink(root, file, io) && !existsSync(file)) return null; // a CI or cloud session links from its environment [E18]
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) return null;
    if (state.unlinking) { io.err('pullboard: [RELAY_UNLINK_PENDING] the remote board is deleted; run pullboard relay off to finish forgetting this device key'); return summary(root, state); }
    try {
      if (state.recovery) throw new Refused('RELAY_RECOVERY_PENDING', `a relay recovery for sequence ${state.recovery.skip} is pending; retry pullboard relay recover --skip ${state.recovery.skip} before syncing`);
      if (!await ensureOrdered(root, file, state, io)) return summary(root, state);
      await flushOutbox(outboxLink(root, file, state, io));
      await catchUp(root, file, state, io);
      if (state.pending) {
        // The complete prefix did not acknowledge this interrupted send. It must not run later.
        delete state.pending;
        saveLink(file, state);
        io.err(`pullboard: the relay ${state.url} did not sequence the previous move; retry that move explicitly if still wanted`);
      }
      // In the background, a command never builds the presentation to compare it: a saved, unsent checkpoint asks
      // for an upload, and any other command asks the publisher to compare, so a spec edit alone still reaches the
      // phone. Otherwise the command publishes a changed presentation itself, as before #1014.
      if (checkpointInBackground()) { if (state.checkpoint) scheduleCheckpoint(root, file); else requestCheckpointCheck(root, file); }
      else if (state.checkpoint || state.presentationDigest !== presentationDigest(relayPresentation(root))) await publishCheckpoint(root, file, state, io);
      await deliverDeviceWraps(root, io);
      if (io.keyRequestsWaiting && !state.environment) await (await import('./relay-handover.js')).handOverKeys(root, state, readBoardKey(state.board), request, io); // an agent token never hands over a key
      return summary(root, state);
    }
    catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (!io.relayCanary) recordClientHealth(root, false, error, Date.now() - roundTripStarted, 'pull');
      if (confirmedDeletion(state, error)) { forgetDeletedCopy(root, file, state, io); return summary(root, null); }
      if (error.code === 'RELAY_KEY_MISSING') {
        if (!KEY_WARNED_COMMANDS.has(io)) {
          KEY_WARNED_COMMANDS.add(io);
          io.err(`pullboard: ${error.message}; moves are off until the key is reachable`);
        }
      } else if (error.code === 'AUTH_REQUIRED') {
        if (!orderedMoveCommand(io)) reportExpiredSignIn(state, io);
      } else if (!(orderedMoveCommand(io) && (baselineNotAccepted(state) || outboxQueueable(state, error, null, io)) && transientRelayFailure(error))) io.err(`pullboard: ${error.message}; run pullboard status to see pending uploads`);
      return { linked: true, board: state.board, url: state.url, sequence: state.sequence,
        behind: (state.mode === 'ordered' ? Number(Boolean(state.pending)) : behind(root, state)) + Number(Boolean(state.snapshot || state.checkpoint)) + (state.outbox?.moves?.length ?? 0),
        recovery: recoverySummary(state), ...outboxFields(state),
        health: readRelayHealth(root, { queued: state.outbox?.moves?.length ?? 0 }) };
    }
  }, io);
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
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    const events = listed.coordinatorEvents ?? [];
    if (!Array.isArray(events) || events.some((row) => !row || !['bootstrap', 'reissue', 'reset'].includes(row.reason) || !uuid.test(row.id ?? '') ||
        !uuid.test(row.session ?? '') || !uuid.test(row.issued ?? '') || !Number.isSafeInteger(row.at) ||
        !Array.isArray(row.revoked) || row.revoked.some((id) => !uuid.test(id ?? '')))) {
      throw new Refused('RELAY_RESPONSE', 'the relay coordinator audit is invalid; retry its configured address');
    }
    const coordinatorEvents = events.map(({ id, reason, session, revoked, issued, at }) => ({ id, reason, session, revoked, issued, at }));
    return { ...tokenContext(state), tokens, coordinatorEvents };
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
    // Queue admission and the local revocation marker share one short guard; the phone and network never hold it.
    await withOutboxGuard(file, () => {
      const current = loadLink(file);
      for (const credential of Object.values(current.agentTokens ?? {})) if (credential.id === id) credential.revoked = true;
      saveLink(file, current);
    });
    return { ...tokenContext(state), id: result.id, revoked: result.revoked };
  });
}

/** Read an acknowledged exact CLI result before changed spec, brief or Git refs can block it. */
export async function relayCommandReceipt(root, command) {
  if (!command) return null;
  const file = linkFile(root);
  // Most commands have no interrupted result to recover: they read that without the relay lock, so an add never
  // waits on the sender holding it (#1013).
  const peek = loadLink(file);
  if (peek && !peek.unlinking && !peek.recovered) return null;
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state) {
      const recovered = deletedRecovery(root);
      if (!recovered || recovered.marker.recovered.commandIntent !== intentDigest(operationIntent('cli:' + command.cliOperation, command))) return null;
      const expected = { add: 'addItem', companion: 'requestCompanion', edit: 'editItem', merged: 'merged', move: 'rehomeItem' }[command.cliOperation];
      if (recovered.move.operation !== expected) throw new Refused('RELAY_STORAGE', 'restore the interrupted command receipt before retrying');
      if (recovered.receipt.outcome.error) {
        clearDeletedRecovery(root, recovered.marker);
        throw refusalFromReceipt(recovered.receipt.outcome.error);
      }
      return { result: recovered.receipt.outcome.result, events: recovered.receipt.outcome.events ?? [], move: recovered.move };
    }
    if (state.unlinking) return null;
    const recovered = state.recovered;
    if (!recovered || recovered.commandIntent !== operationIntent('cli:' + command.cliOperation, command)) return null;
    if (recovered.commandIntent !== operationIntent('cli:' + recovered.command?.cliOperation, recovered.command)) {
      throw new Refused('RELAY_STORAGE', 'restore the interrupted command metadata before retrying');
    }
    const expected = { add: 'addItem', companion: 'requestCompanion', edit: 'editItem', merged: 'merged', move: 'rehomeItem' }[command.cliOperation];
    if (!recovered.move || recovered.move.operation !== expected) throw new Refused('RELAY_STORAGE', 'restore the interrupted command metadata before retrying');
    const move = recoveredMove(root, state, recovered.move.operation, recovered.move.args, command);
    const receipt = localRecords(root, board => engineReceipt(board, move.id));
    if (receipt.outcome.error) {
      delete state.recovered;
      saveLink(file, state);
      throw refusalFromReceipt(receipt.outcome.error);
    }
    return { result: receipt.outcome.result, events: receipt.outcome.events ?? [], move };
  });
}

/** Consume the exact cached result after its original CLI outcome has been formatted. */
export async function relayCommandReceiptReported(root, moveId) {
  const file = linkFile(root);
  const peek = loadLink(file);
  if (peek && peek.recovered?.move?.id !== moveId) return;
  return locked(file, async () => {
    const state = loadLink(file);
    if (state?.recovered?.move?.id === moveId) {
      delete state.recovered;
      saveLink(file, state);
    } else if (!state) {
      const recovered = deletedRecovery(root);
      if (recovered?.move.id === moveId) clearDeletedRecovery(root, recovered.marker);
    }
  });
}

/** Expose only an unreported operation descriptor so CLI preconditions cannot strand its outcome. */
export function relayRecovered(root, { includePending = false } = {}) {
  const state = loadLink(linkFile(root));
  return state ? state.recovered?.move ?? (includePending ? state.pending?.move : null) ?? null : deletedRecovery(root)?.move ?? null;
}

/** Explicitly refuse one blocked position, replay its valid tail on a private copy, then publish it. */
export async function relayRecover(root, skip, io) {
  const file = linkFile(root);
  return locked(file, async () => {
    const state = loadLink(file);
    if (!state || state.unlinking || state.mode !== 'ordered') throw new Refused('RELAY_LINKED', 'link this ordered relay board before recovering a blocked sequence');
    const boardFile = join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite');
    const source = store.openBoard(boardFile, undefined, { isMain: codeIsFromMain(), gitRoot: root });
    const staged = store.openBoard(':memory:', undefined, { gitRoot: root });
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
export function relayStatus(root) { return withRelayExclusion(root, summary(root, loadLink(linkFile(root)))); }

/** Cancel one device ticket without the already-aborted caller signal. */
async function cancelDeviceFlow(url, ticket, io) {
  let result;
  try { result = await request({ url }, '/auth/device/cancel', { method: 'POST', body: { ticket } }, io); }
  catch {
    throw new Refused('OAUTH_CLEANUP', 'the relay could not confirm cleanup of the cancelled sign-in; retry before linking boards');
  }
  if (result.cancelled !== true) throw new Refused('OAUTH_CLEANUP', 'the relay did not confirm cleanup of the cancelled sign-in; retry before linking boards');
}

/** Revoke only the fresh person session created by this explicit device sign-in. */
export async function revokeRelayPersonSession(session, io) {
  if (!session || typeof session.token !== 'string' || !/^ps_[A-Za-z0-9_-]{43}$/.test(session.token) || typeof session.id !== 'string') {
    throw new Refused('OAUTH_CLEANUP', 'the relay session could not be identified for cancellation cleanup');
  }
  const result = await request({ url: session.url, token: session.token }, '/auth/tokens/revoke', { method: 'POST', body: { id: session.id } }, io);
  if (result.id !== session.id || result.revoked !== true) throw new Refused('OAUTH_CLEANUP', 'the relay did not confirm cleanup of the cancelled sign-in; retry before linking boards');
}

/** Sign in with the caller's cancellation signal; no board credential is persisted here. */
async function deviceSignIn(url, io, { signal, intent, onSignIn } = {}) {
  cancellationOutcome(signal);
  const client = { url };
  const flow = await request(client, '/auth/device/start', { method: 'POST', body: intent ? { intent } : {}, signal }, io);
  try {
    cancellationOutcome(signal);
    io.stderr.write(intent
      ? `Sign in with GitHub for board ${intent.boardName} from ${intent.host}: open ${flow.verificationURL} and enter ${flow.userCode}. After sign-in, confirm the link in your browser: ${flow.confirmationURL}\n`
      : `Sign in with GitHub: open ${flow.verificationURL} and enter ${flow.userCode}\n`);
    if (intent && typeof flow.confirmationURL !== 'string') throw new Refused('RELAY_RESPONSE', 'the relay did not provide a board confirmation page; sign in again');
    let expires = Date.now() + flow.expiresIn * 1000;
    // The view receives only the public device instructions. The ticket stays in this stack.
    onSignIn?.({ verificationURL: flow.verificationURL, userCode: flow.userCode, expiresAt: expires, relayUrl: url });
    let confirmationPending = false;
    let signed;
    let wait = flow.interval;
    do {
      await waitForDevicePoll(wait, signal);
      if (!confirmationPending && Date.now() >= expires) throw new Refused('OAUTH_EXPIRED', 'GitHub device sign-in expired; run pullboard relay on again');
      signed = await request(client, '/auth/device/poll', { method: 'POST', body: { ticket: flow.ticket }, signal }, io);
      cancellationOutcome(signal);
      if (signed.pendingConfirmation && Number.isSafeInteger(signed.confirmationExpiresIn)) {
        confirmationPending = true;
        expires = Date.now() + signed.confirmationExpiresIn * 1000;
      }
      wait = signed.retryAfter ?? flow.interval;
    } while (signed.pending);
    const token = signed.token;
    if (!/^ps_[A-Za-z0-9_-]{43}$/.test(token)) throw new Refused('RELAY_RESPONSE', 'the relay did not issue a person session; sign in again');
    return signed;
  } catch (error) {
    if (signal?.aborted || error.code === 'OAUTH_CANCELLED') {
      await cancelDeviceFlow(url, flow.ticket, io);
      throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
    }
    throw error;
  }
}

/** Explicitly sign in through the relay and persist a sealed initial snapshot before uploading it. */
export async function relayOn(root, address, io, { session, credential, quiet = false, strict = false, name } = {}) {
  const label = computerName(name);
  const remoteShell = io.personChannel !== 'view' && isRemoteShell();
  const reusableSession = remoteShell ? undefined : session;
  const reusableCredential = remoteShell ? undefined : credential;
  if (remoteShell) {
    requireRelayOnChannel(io.personChannel);
    io.ignoreRelayEnvironmentToken = true;
  } else if (!reusableCredential) requirePersonChannel(io.personChannel);
  readRelayMachine();
  for (const project of listApiProjects()) { try { loadLink(linkFile(project.root)); } catch { /* Report this command's own link below. */ } }
  const repository = originRepository(root);
  const file = linkFile(root);
  // A clone whose pullboard.json names another board joins that board instead of linking a second one [E12].
  const joining = await (await import('./relay-join.js')).joinNamedBoardIfAny(root, file, { linked: Boolean(loadLink(file)), url: relayOrigin(address || DEFAULT_RELAY), repository, signIn: (url) => deviceSignIn(url, io) }, io);
  if (joining) return joining;
  const { nameBoardInConfig } = await import('./relay-board-config.js');
  return locked(file, async () => {
    let state = loadLink(file);
    if (state) requireUnconflictedBaseline(state);
    if (state?.unlinking) throw new Refused('RELAY_UNLINK_PENDING', 'finish this device key cleanup with pullboard relay off before linking again');
    const url = relayOrigin(address || state?.url || DEFAULT_RELAY);
    if (state && (state.url !== url || state.repository !== repository)) throw new Refused('RELAY_LINKED', 'this board is linked to another relay or repository; run relay off before changing its link');
    const key = state ? readBoardKey(state.board) : await generateBoardKey();
    const nextBoard = state?.board ?? plannedRelayBoard(root, localRecords(root, store.boardId));
    const relink = state ? null : relayRelink(root);
    const replacement = relinkReplacement(state, relink, deletedLink(root)?.board);
    const intent = remoteShell ? { board: nextBoard, repository,
      host: hostname(), boardName: basename(root), ...(replacement ? { replaces: replacement } : {}) } : undefined;
    const signed = remoteShell ? await deviceSignIn(url, io, { intent }) : reusableCredential ?? reusableSession ?? await deviceSignIn(url, io);
    if (reusableSession && reusableSession.url !== url) throw new Refused('RELAY_SESSION', 'Sign in again to this relay with pullboard relay on --all.');
    // Every clone finds its board in pullboard.json [E12], written before the snapshot so its presentation carries it.
    const restoreConfig = nameBoardInConfig(repoInfo(root).root, nextBoard, io);
    if (!state) {
      const snapshot = localRecords(root, (board) => {
        startRelayEpoch(board, nextBoard);
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
      if (relink && replacement) { state.previousBoardNotice = relink.previous; state.replaces = replacement; }
    }
    const account = signed.account ?? signed.user?.id;
    // Persist the exact sealed snapshot and a recoverable link intent before making the remote link.
    saveLink(file, state);
    if (relink) finishRelink(root);
    if (state.linkPending) {
      if (signed.linkConfirmed && signed.linkedBoard !== state.board) throw new Refused('RELAY_RESPONSE', 'the relay confirmed a different board; sign in again');
      // Another board is the repository's: forget this never-linked intent so relay on can join it [E12].
      if (!reusableCredential && !signed.linkConfirmed) await (await import('./relay-relink.js')).linkReplacing((replaces) => request({ ...state, token: signed.token }, '/auth/boards/link', { method: 'POST', body: { board: state.board, repository, ...(replaces ? { replaces } : {}) } }, io), state.replaces)
        .catch((error) => { if (error.code === 'BOARD_REPO_LINKED') restoreConfig(() => { rmSync(file, { force: true }); forgetBoardKey(state.board, state.keyStorage); }); throw error; });
      delete state.linkPending; delete state.replaces;
      saveLink(file, state);
    }
    const machine = updateRelayMachine(settings => settings.machine);
    const named = computerName(label ?? state.computerName ?? readRelayMachine().computerName);
    const issued = reusableCredential ?? await request({ ...state, token: signed.token }, '/auth/machines', { method: 'POST', body: { board: state.board, machine, ...(named === undefined ? {} : { name: named }) } }, io);
    if (!/^pm_[A-Za-z0-9_-]{43}$/u.test(issued.token ?? '') || issued.board !== state.board || issued.machine !== machine) throw new Refused('RELAY_RESPONSE', 'the relay did not issue this board’s machine credential; sign in again');
    // Cached agent credentials belong to the account that minted them.
    if (state.account !== account) { delete state.agentTokens; delete state.login; }
    state.account = account;
    // Kept so relay status can name who linked the board; a phone-approved credential carries none.
    const login = signed.login ?? signed.user?.login;
    if (typeof login === 'string' && login) state.login = login;
    state.token = issued.token;
    state.tokenId = issued.id;
    state.machine = machine;
    if (named !== undefined) state.computerName = named;
    delete state.personReauth;
    saveLink(file, state);
    // The person's own sign-in sets up the coordinator's token, so no agent can mint it (#579).
    if (/^ps_[A-Za-z0-9_-]{43}$/u.test(signed.token ?? '')) { await ensurePersonCoordinator(file, state, signed.token, io); await syncApprovers(root, state, signed.token, io); }
    let result;
    let clearedExclusion = false;
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
        rmSync(deletedLinkFile(root), { force: true });
        await flushOutbox(outboxLink(root, file, state, io));
        await catchUp(root, file, state, io);
        await deliverDeviceWraps(root, io);
        clearedExclusion = clearRelayExclusion(root);
        if (reusableSession === undefined) await publishExcludedBoards({ ...signed, account, url }, io, request);
      }
      result = summary(root, state, { pairing: !quiet });
    }
    catch (error) { if (strict || !(error instanceof Refused)) throw error; io.err(`pullboard: ${error.message}; pending records are queued for the next command`); result = summary(root, state, { pairing: !quiet }); }
    if (!quiet) io.say(terminalQr(result.link));
    if (state.previousBoardNotice) {
      result.notice = 'Linked a fresh relay board. The old remote copy stays until you delete it from your phone.';
      io.err(result.notice);
      delete state.previousBoardNotice;
      saveLink(file, state);
    }
    if (clearedExclusion) reportClearedExclusion(result, io);
    return result;
  });
}

/** Unlink locally without approval, then request a separate phone-approved remote deletion if possible. */
export async function relayOff(root, io) {
  const file = linkFile(root);
  return locked(file, async () => {
    excludeRelayByPerson(root, io, { localRecords });
    const state = loadLink(file);
    if (!state) { await publishOffExclusions(null, io, { loadLink, linkFile, request: relayDeviceRequest }); return summary(root, null); }
    let joined = [];
    try {
      const roster = await request(state, '/auth/machines?board=' + state.board, {}, io);
      if (Array.isArray(roster.machines)) joined = roster.machines.filter(entry => typeof entry.machine === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(entry.machine) && entry.machine !== state.machine).map(entry => ({ machine: entry.machine, name: typeof entry.name === 'string' ? computerName(entry.name) : 'computer ' + entry.machine.slice(-8) }));
    } catch { /* Local unlink still completes when the relay cannot inventory joined computers. */ }
    const warning = joined.length ? ' If you approve deletion, joined computers ' + joined.map(entry => entry.name).join(', ') + ' lose the shared copy; their local boards keep working.' : '';
    if (warning) io.err(warning.trim());
    // Local unlink always completes, including agent shells, outages and a fenced remote baseline.

    let proposal;
    try { proposal = await phoneProposal(state, 'delete-board', state.board, { root }); }
    catch { /* Missing key or pairing cannot stop local unlinking. */ }
    rememberRelink(root, state.board);
    // A local-first move queues under the outbox guard, so the outbox is set aside under it too (#1013).
    await withOutboxGuard(file, () => archiveRelinkOutbox(root, state));
    rmSync(file, { force: true });
    try { forgetBoardKey(state.board, state.keyStorage); }
    catch { /* The local opt-out is complete even when secure key storage is temporarily locked. */ }
    await publishOffExclusions(state, io, { loadLink, linkFile, request: relayDeviceRequest });
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
      ...(joined.length ? { affectedMachines: joined.map(entry => entry.machine), joined: joined.map(entry => entry.name) } : {}),
      notice: 'Local link removed. The relay copy stays until you approve deleting it on your phone.' + warning + (requested ? '' : ' Open the phone to manage the relay copy.') };
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
export async function relayMachineSignIn(address, io, { signal, onSignIn } = {}) {
  requirePersonChannel(io.personChannel);
  const url = relayOrigin(address || DEFAULT_RELAY);
  let signed;
  try { signed = await deviceSignIn(url, io, { signal, onSignIn }); }
  catch (error) {
    if (error.code === 'OAUTH_CLEANUP') throw error;
    if (signal?.aborted || error.code === 'OAUTH_CANCELLED') return { outcome: 'cancelled' };
    if (error.code === 'OAUTH_DENIED') return { outcome: 'declined' };
    if (error.code === 'OAUTH_EXPIRED') return { outcome: 'expired' };
    throw error;
  }
  if (signal?.aborted) {
    await revokeRelayPersonSession({ ...signed, url }, io);
    return { outcome: 'cancelled' };
  }
  if (typeof signed.user?.id !== 'string') throw new Refused('RELAY_RESPONSE', 'Sign in again to receive an authenticated account identity.');
  // The login is display text only: the account id stays the identity every check compares.
  return { token: signed.token, id: signed.id, account: signed.user.id, login: typeof signed.user.login === 'string' ? signed.user.login : '', url };
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
  await deliverPersonEnrollments(state, io, request);
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

/** Ignore notices from courtesy roster reads; disconnected boards keep their local labels and dates. */
function ignoreRosterNotice() {}

const ROSTER_READ_IO = Object.freeze({ ignoreRelayEnvironmentToken: true, err: ignoreRosterNotice });

/** Read only the fixed, board-scoped roster resources through the CLI's existing outbound transport. */
export async function relayRosterRead(state, path) {
  const board = typeof state?.board === 'string' && /^[0-9a-f]{32}$/u.test(state.board);
  const allowed = typeof path === 'string' && (path === '/api/v1/devices' || /^\/api\/v1\/devices\/device-[0-9a-f]{32}$/u.test(path) ||
    (board && path === `/auth/machines?board=${state.board}`));
  if (!allowed) throw new Refused('RELAY_ROSTER_PATH', 'the roster requested an unsupported relay resource');
  return request(state, path, { method: 'GET', signal: AbortSignal.timeout(5000) }, ROSTER_READ_IO);
}

/** Require one exact phone approval before revoking and removing a device from the trusted roster. */
export async function relayRevokeDevice(root, deviceId, io) {
  requirePersonChannel(io.personChannel);
  const state = managementLink(linkFile(root));
  const result = await nativePhoneAction(state, 'revoke-device', deviceId, io, request);
  removeRecordedDevice(deviceId);
  updateRelayMachine(machine => { machine.revocations = machine.revocations.filter(entry => entry.deviceId !== deviceId); });
  return { ...result, notice: 'Revoked device; keys it already received remain known. Board key rotation is separate.' };
}
