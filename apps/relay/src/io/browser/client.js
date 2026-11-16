import { realRelayAdapter } from '../browser-adapter.js';
import { browserPersonBarEffect } from './person-bar-effect.js';
/** Device-only relay transport: cookie authorization, local keys and authenticated ciphertext [H5,H15,H16,H17]. */
import {
  rememberDevicePairing,
  enrollPhone,
  deviceBoardKeyState,
  installPhoneApprovals,
  forgetDevice,
} from './devices.js';
import {
  decodeBoardKey,
  encodeBoardKey,
  seal,
  unseal,
} from './seal.js';
import {
  preparePersonRequest,
  validatePersonRequest,
} from './person-request.js';
import {
  snapshotState,
  presentationState,
} from './model.js';
import { ENGINE_VERSION } from './engine.js';
import { Refused } from './refused.js';
import { SNAPSHOT_BODY_BYTES } from './relay-limits.js';
import {
  enqueueStream,
  followStream,
} from '../../logic/browser/stream.js';
import {
  recordBrowserReadFailure,
  relayFailureText,
  clearBrowserReadFailure,
  emptyBoardStep,
  homeLineDismissed,
  homeScreenLine,
  noticeLines,
  rememberOwnedRequestId,
  showRelayScreen,
  storedOwnedRequestState,
} from './notice.js';
import {
  registerApp,
  requestPairingPersistence,
} from './install.js';
import {
  browserJSON,
  withBrowserDeadline,
} from '../../logic/browser/deadline.js';
import {
  phoneApprovalStatus,
  placePhoneApprovals,
  forgetPhoneApprovals,
} from '../../logic/browser/card.js';
import { phoneSnapshotPages } from '../../logic/browser/pages.js';
import { createPhoneHistory } from './history.js';
import {
  installPersonPasskeys,
  passkeyPresence,
} from './passkeys.js';
import { readUploadSize } from '../../logic/browser/status.js';
import { deviceExcludedBoards } from './devices.js';

const CHECKPOINT_WAIT_MS = 15_000;
const KEYS = 'pullboard.relay.keys.v1';
const PENDING = 'pullboard.relay.pair.v1';
const OUTBOX = 'pullboard.relay.requests.v1.';
const OWNED = 'pullboard.relay.owned-requests.v1.';
const BOARD = /^[0-9a-f]{32}$/;

/** Read private browser storage without turning unavailable storage into a credential diagnostic. */
function stored(storage, name, fallback) {
  try { return JSON.parse(storage.getItem(name)) ?? fallback; } catch { return fallback; }
}

/** The validated pairing this page read before its transport took it; module memory only, never a global or storage. */
let earlyPairing = null;

/** Keep an unauthenticated pairing fragment on the device through the GitHub redirect. */
export function rememberPairing() {
  rememberDevicePairing();
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has('board') && !fragment.has('key')) return null;
  const board = fragment.get('board');
  const key = fragment.get('key');
  if (!BOARD.test(board ?? '')) throw new Error('The pairing link is invalid. Get a new link from a linked machine.');
  decodeBoardKey(key);
  const pair = { board, key };
  try { sessionStorage.setItem(PENDING, JSON.stringify(pair)); } catch { /* Current visit can still pair in memory. */ }
  history.replaceState(null, '', location.pathname + location.search);
  earlyPairing = pair;
  return pair;
}

/** Hand the transport the pairing this page already read, once, so an early read survives refused storage. */
function takePairing() {
  const pair = earlyPairing;
  earlyPairing = null;
  return pair;
}

/** Decode canonical sealed transport bytes without putting their value in an error. */
function transportBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > SNAPSHOT_BODY_BYTES) throw new Error('The sealed board response is invalid. Refresh this board.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Inflate a new gzip snapshot or preserve the legacy JSON plaintext format. */
async function snapshotDocument(plain) {
  if (plain[0] === 0x1f && plain[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read gzip snapshots. Upgrade the browser client.');
    try {
      // A Response body, not Blob.stream(): WebKit refuses to decode gzip piped from a Blob stream.
      const stream = new Response(plain).body.pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await withBrowserDeadline(() => new Response(stream).text()));
    } catch { throw new Refused('SNAPSHOT_FORMAT', 'The sealed gzip snapshot is invalid. Refresh it from a linked machine.'); }
  }
  if (plain[0] !== 0x7b) {
    const seen = [...plain.slice(0, 4)].map(value => value.toString(16).padStart(2, '0')).join('') || 'no bytes';
    throw new Refused('SNAPSHOT_FORMAT', `The sealed snapshot starts with ${seen}; expected gzip magic 1f8b or legacy JSON starting with 7b.`);
  }
  try { return JSON.parse(new TextDecoder().decode(plain)); }
  catch { throw new Refused('SNAPSHOT_FORMAT', 'The sealed legacy JSON snapshot is invalid. Refresh it from a linked machine.'); }
}

/** Confirm session authorization before treating a board-local refusal as global access loss. */
async function checkAuthorization(path, status, onDenied, error) {
  if (error?.code === 'DEVICE_REVOKED' && onDenied) { await onDenied(error); return; }
  if (![401, 403].includes(status) || !onDenied) return;
  if (['/api/v1/boards', '/api/v1/devices/session'].includes(new URL(path, location.origin).pathname)) onDenied();
  else await rawDocumentAt('/api/v1/devices/session', onDenied);
}

/** Fetch only same-origin API documents, retaining stable refusal guidance and no provider details. */
async function rawDocumentAt(path, onDenied, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set('x-pullboard-engine', String(ENGINE_VERSION));
  const { response, document } = await browserJSON(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) {
    const error = document.error;
    await checkAuthorization(path, response.status, onDenied, error);
    if (error) throw new Refused(error.code, error.message);
    throw new Refused('RELAY_UNAVAILABLE', 'The relay did not answer. Sign in again or retry.');
  }
  if (document.version !== 1) throw new Error('This relay API version is unsupported. Upgrade this browser client.');
  return document;
}

/** Build the API adapter the existing cockpit consumes; no board key enters an HTTP request. */
export async function createTransport({ onUpdate = () => {}, onOpenBoard = () => {}, waitForRender = false } = {}) {
  void registerApp();
  const savedKeys = stored(localStorage, KEYS, {});
  const keys = savedKeys && typeof savedKeys === 'object' && !Array.isArray(savedKeys) ? savedKeys : {};
  const paired = new Map();
  let available = [];
  let inventoryLoaded = false;
  let browserPaired = false;
  let waitingBoards = new Map();
  const approvedBoards = new Set();
  let pendingLinks = [];
  let pendingLinksFailure = '';
  let sizeProblems = new Map();
  let exclusions = [];
  let exclusionsFailure = '';
  let warnings = [];
  let failure = '';
  let failureBoard = null;
  const degradedBoards = new Map();
  let accessLost = false;
  let accessError = null;
  const access = new AbortController();
  // Passkey answers for requests in flight, by request id: memory only, spent by the relay on first use [E22].
  const presences = new Map();
  let persistenceRequest = null;
  // New viewers acknowledge their first actual render; old viewers retain the prior transition contract.
  let rendered = waitForRender !== true;
  rememberPairing();
  let pair = takePairing() ?? stored(sessionStorage, PENDING, null);
  if (pair && (!BOARD.test(pair.board ?? '') || typeof pair.key !== 'string')) pair = null;
  try { if (pair) decodeBoardKey(pair.key); } catch { pair = null; }

  /** Observe failed board reads on this phone; user-intent refusals are not transport health. */
  async function documentAt(path, onDenied, options = {}) {
    try { return await rawDocumentAt(path, onDenied, options); }
    catch (error) {
      const id = /^\/api\/v[12]\/boards\/([^/]+)\//u.exec(new URL(path, location.origin).pathname)?.[1];
      if (id && (!options.method || options.method === 'GET') && !['NO_ITEM', 'NO_SHOUT', 'BAD_REQUEST'].includes(error?.code)) {
        recordBrowserReadFailure(degradedBoards, id); notice();
      }
      throw error;
    }
  }

  /** Preserve shared collections across updates: the cockpit shallow-copies state and revocation must clear those arrays too. */
  function installState(entry, value) {
    if (!entry.state) { entry.state = value; return; }
    for (const [field, previous] of Object.entries(entry.state)) {
      if (Array.isArray(previous) && previous !== value[field]) {
        previous.length = 0;
        if (Array.isArray(value[field])) {
          for (const row of value[field]) previous.push(row);
          Object.defineProperty(value, field, { ...Object.getOwnPropertyDescriptor(value, field), value: previous });
        }
      }
      if (!Object.hasOwn(value, field)) delete entry.state[field];
    }
    Object.defineProperties(entry.state, Object.getOwnPropertyDescriptors(value));
  }

  /** Keep newer received events visible while only a native checkpoint may replace item state. */
  function checkpointState(entry, state, sequence) {
    const pending = (entry.state?.pendingEvents ?? []).filter(event => event.sequence > sequence);
    delete state.pendingEvents;
    if (pending.length) state.pendingEvents = pending;
    const requests = (entry.state?.personRequests ?? []).filter(request => request.sequence > sequence);
    if (requests.length) {
      const known = new Set((state.personRequests ?? []).map(request => request.id));
      state.personRequests = [...(state.personRequests ?? []), ...requests.filter(request => !known.has(request.id))];
    }
    return state;
  }

  /** Advance the checkpoint cursor independently of the already authenticated event prefix. */
  function installCheckpoint(entry, state, sequence) {
    installState(entry, checkpointState(entry, state, sequence));
    entry.checkpointCursor = sequence;
    entry.cursor = Math.max(entry.cursor, sequence);
    for (const pending of entry.pendingSince?.keys() ?? []) if (pending <= sequence) entry.pendingSince.delete(pending);
    if (entry.checkpointTimedOut && !pendingCheckpointTimeout(entry)) {
      entry.checkpointTimedOut = false;
      // Reconnect at the authenticated prefix after a timed-out checkpoint, without reloading the page.
      if (entry.stream) subscribe(entry);
    }
  }

  /** Retain the declared checkpoint timeout without blocking reception of later authenticated events. */
  function pendingCheckpointTimeout(entry) {
    for (const since of entry.pendingSince?.values() ?? []) {
      if (Date.now() - since < CHECKPOINT_WAIT_MS) continue;
      entry.checkpointTimedOut = true;
      return true;
    }
    return false;
  }

  /** Poll in the cursor queue without blocking later events while the native publisher is behind. */
  function pendingCheckpoint(entry) {
    if (entry.snapshotPolling || !entry.state?.pendingEvents?.length || access.signal.aborted) return;
    entry.snapshotPolling = true;
    entry.snapshotTimer = setTimeout(() => {
      entry.snapshotTimer = null;
      if (access.signal.aborted || paired.get(entry.id) !== entry) { entry.snapshotPolling = false; return; }
      void enqueue(entry, async () => {
        const previous = entry.checkpointCursor;
        await snapshot(entry);
        if (access.signal.aborted || paired.get(entry.id) !== entry) return;
        pendingCheckpointTimeout(entry);
        notice();
        if (entry.checkpointCursor !== previous) onUpdate();
      }).catch(error => {
        if (access.signal.aborted || paired.get(entry.id) !== entry) return;
        // A rejected checkpoint cannot erase the existing timeout or the pending-event marks.
        if (!pendingCheckpointTimeout(entry)) { failure = relayFailureText(error); failureBoard = entry.id; }
        notice();
      }).finally(() => { entry.snapshotPolling = false; pendingCheckpoint(entry); });
    }, 1000);
  }

  /** Discard decrypted memory and this document when relay authorization is lost. */
  async function denied(error) {
    if (accessLost) return;
    accessLost = true;
    accessError = error ?? new Refused('AUTH_REQUIRED', 'Sign in again to read this board.');
    access.abort();
    forgetPhoneApprovals(document);
    for (const entry of paired.values()) {
      entry.stream?.close();
      entry.history?.close(); entry.pageCache?.clear(); entry.pages = null;
      // The cockpit holds this same projection. Clear its arrays before releasing our reference.
      if (entry.state) for (const [field, value] of Object.entries(entry.state)) {
        if (Array.isArray(value)) value.length = 0;
        else delete entry.state[field];
      }
      if (Array.isArray(entry.shouts)) entry.shouts.length = 0;
      entry.state = null; entry.shouts = null; entry.outbox = null;
      if (entry.key instanceof Uint8Array) entry.key.fill(0);
      entry.key = null;
    }
    paired.clear();
    available = []; waitingBoards.clear(); sizeProblems.clear(); pendingLinks = []; pendingLinksFailure = ''; exclusions = []; exclusionsFailure = ''; warnings = []; pair = null;
    for (const id of Object.keys(keys)) delete keys[id];
    document.querySelector('main')?.replaceChildren();
    if (error?.code !== 'DEVICE_REVOKED') { location.replace('/'); return; }
    let cleanupFailed = false;
    try {
      localStorage.removeItem(KEYS);
      for (const key of Object.keys(localStorage)) if (key.startsWith(OUTBOX) || key.startsWith(OWNED)) localStorage.removeItem(key);
      sessionStorage.removeItem(PENDING);
      sessionStorage.removeItem('pullboard.relay.device-pair.v1');
    } catch { cleanupFailed = true; }
    try { await forgetDevice(); } catch { cleanupFailed = true; }
    const panel = document.createElement('section');
    panel.id = 'relay-removed'; panel.className = 'card-panel'; panel.setAttribute('role', 'status');
    panel.textContent = 'This browser was removed from the board. ' + (cleanupFailed
      ? 'Clear this browser’s site data, then sign in again and get a fresh pairing link from a linked Mac.'
      : 'Sign in again and get a fresh pairing link from a linked Mac.');
    const signIn = document.createElement('a'); signIn.href = '/auth/github/start'; signIn.textContent = 'Sign in with GitHub';
    panel.append(document.createElement('br'), signIn);
    document.documentElement.dataset.relayScreen = 'removed';
    document.body.append(panel);
  }

  /** Render only authorized board names, safe warnings and pairing guidance into the generic page. */
  function notice() {
    if (accessLost) return;
    const element = document.getElementById('relay-notice');
    if (!element) return;
    element.replaceChildren();
    const ownedRequestIds = new Map();
    const queuedRequests = new Map();
    for (const [id, entry] of paired) {
      const key = OWNED + id;
      let state = { owned: new Set() };
      try { state = storedOwnedRequestState(localStorage, key, entry.state?.personRequests); } catch { /* Missing device storage can only hide this device's own notice. */ }
      ownedRequestIds.set(id, state.owned);
      try { queuedRequests.set(id, pendingRequests(entry).length); }
      catch { queuedRequests.set(id, null); }
    }
    const lines = noticeLines({ available, paired, ownedRequestIds, degradedBoards, queuedRequests, waitingBoards, sizeProblems, approvedBoards, pendingLinks, warnings, exclusions,
      failure: failure || pendingLinksFailure || exclusionsFailure });
    for (const text of lines) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      element.append(paragraph);
    }
    for (const entry of paired.values()) for (const event of entry.state?.pendingEvents ?? []) {
      const paragraph = document.createElement('p');
      const operation = String(event.operation).replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
      paragraph.textContent = 'Pending event #' + event.sequence + ' on ' + entry.repository + ': ' + operation + (event.title ? ' — ' + event.title : '');
      element.append(paragraph);
    }
    // A phone has no local-view screen to fall back to: keep its shell and the real reason until a board is readable.
    const root = document.documentElement;
    const phoneWaiting = root.dataset.relayDevice === 'phone' && (!rendered || paired.size === 0);
    const step = emptyBoardStep({ available, waitingBoards, sizeProblems, approvedBoards, loaded: inventoryLoaded, browserPaired, failure, exclusions });
    showRelayScreen(root, phoneWaiting || paired.size === 0 ? 'share' : null,
      phoneWaiting && (failure || waitingBoards.size || warnings.some(value => ['ACCOUNT_STORAGE_WARNING', 'ACCOUNT_STORAGE_LIMIT'].includes(value?.code))) ? lines.join(' ') : '', step);
    placePhoneApprovals(document);
  }

  /** Ask once after pairing; a refusal leaves one dismissible line under the board, never above it. */
  function keepPairingStorage() {
    persistenceRequest ??= requestPairingPersistence().then(kept => {
      const current = document.getElementById('pairing-storage-notice');
      if (kept || homeLineDismissed(localStorage)) { current?.remove(); return; }
      const main = document.querySelector('main');
      // The answer comes later: a board lost meanwhile, or access lost, leaves no line about keeping it.
      if (!main || accessLost || current || paired.size === 0) return;
      main.append(homeScreenLine(document, localStorage));
    });
  }

  /** Keep one missing-snapshot board visible as waiting without clearing other authorized boards. */
  function waitForFirstSnapshot(entry) {
    entry.stream?.close();
    entry.history?.close(); entry.history = null; entry.pageCache?.clear(); entry.pages = null;
    entry.state = null;
    entry.shouts = null;
    paired.delete(entry.id);
    const board = available.find(value => value.id === entry.id);
    waitingBoards.set(entry.id, board?.repository ?? entry.repository ?? 'This board');
    notice();
  }

  /** Retain one warning per board without duplicating it on the next live poll. */
  function warning(value, boardId) {
    if (!value || !['BOARD_INACTIVE', 'ACCOUNT_STORAGE_WARNING', 'ACCOUNT_STORAGE_LIMIT'].includes(value.code)) return;
    warnings = warnings.filter(entry => entry.board !== boardId || entry.code !== value.code);
    warnings.push({ ...value, board: boardId });
    notice();
  }

  /** Keep full history beside the live cursor; a completed old checkpoint never replaces newer current state. */
  function historyFor(entry) {
    entry.history ??= createPhoneHistory({
      active: () => !accessLost && paired.get(entry.id) === entry,
      current: () => ({ id: entry.pages?.id, sequence: entry.checkpointCursor }),
      install(full, details) {
        const state = presentationState(full, entry.id);
        if (details) state.items = state.items.map(item => details.get(item.id) ?? item);
        installState(entry, checkpointState(entry, { ...state, historyProgress: entry.history.status() }, entry.checkpointCursor));
        entry.historyChanged = true;
      },
      changed() {
        if (entry.state) entry.state.historyProgress = entry.history.status();
        // Progress itself is local state. Only new board data or completion asks the cockpit to refresh the relay.
        if (entry.historyChanged || entry.history.status().complete) { entry.historyChanged = false; onUpdate(); }
      },
      failed() {
        failure = 'Older history did not finish loading. Open this board again to retry.';
        failureBoard = entry.id; notice();
      },
    });
    return entry.history;
  }

  /** Read an optional authenticated size diagnosis without holding up a missing board's waiting screen. */
  function sizeNotice(entry) {
    const waiting = waitingBoards;
    void readUploadSize(path => documentAt(path, undefined, { signal: access.signal }), entry).then(size => {
      if (accessLost || waitingBoards !== waiting || !waiting.has(entry.id)) return;
      if (size) sizeProblems.set(entry.id, size);
      else sizeProblems.delete(entry.id);
      notice();
    }).catch(() => { /* An unavailable or invalid optional notice is not evidence of a size or authorization problem. */ });
  }

  /** Authenticate the latest native snapshot before installing its presentation in this device. */
  async function snapshot(entry) {
    try { return await readSnapshot(entry); }
    catch (error) {
      if (!access.signal.aborted) { recordBrowserReadFailure(degradedBoards, entry.id); notice(); }
      throw error;
    }
  }

  /** Decode the actual checkpoint before a later complete prefix can clear degraded status. */
  async function readSnapshot(entry) {
    let path = '/api/v' + (entry.snapshotApiVersion === 2 ? '2' : '1') + '/boards/' + entry.id + '/state';
    const settings = {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: access.signal,
      headers: { 'x-pullboard-engine': String(ENGINE_VERSION), ...(entry.snapshotApiVersion !== 2 && entry.state && entry.snapshotTag ? { 'if-none-match': entry.snapshotTag } : {}) },
    };
    let { response, document } = await browserJSON(path, settings);
    if (!response.ok && document?.error?.code === 'RELAY_API_VERSION' && entry.snapshotApiVersion !== 2) {
      entry.snapshotApiVersion = 2; entry.snapshotTag = null;
      path = '/api/v2/boards/' + entry.id + '/state';
      ({ response, document } = await browserJSON(path, { ...settings, headers: { 'x-pullboard-engine': String(ENGINE_VERSION) } }));
    }
    if (response.status === 304 && entry.state) return;
    if (!response.ok) {
      await checkAuthorization(path, response.status, denied, document.error);
      if (document.error?.code === 'NO_BOARD' || document.error?.code === 'NO_SNAPSHOT') {
        waitForFirstSnapshot(entry);
        sizeNotice(entry);
      }
      throw new Error(document.error ? '[' + document.error.code + '] ' + document.error.message : 'The relay snapshot is unavailable. Retry.');
    }
    if (document.version !== 1) throw new Error('This relay API version is unsupported. Upgrade this browser client.');
    const row = document.state;
    if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 0) throw new Error('The relay snapshot cursor is invalid. Refresh this board.');
    warning(row.warning, entry.id);
    if (row.apiVersion === 2) {
      entry.pageCache ??= new Map();
      const page = await phoneSnapshotPages(row, { boardId: entry.id, key: entry.key, maxEngine: ENGINE_VERSION, cache: entry.pageCache,
        read: target => documentAt(target, denied, { signal: access.signal }),
        bound: work => withBrowserDeadline(work, { signal: access.signal }),
      });
      if (accessLost) throw accessError;
      const unchanged = entry.pages?.id === page.id && entry.state;
      if (row.sequence >= entry.checkpointCursor && !unchanged) {
        const value = await page.presentation();
        if (accessLost) throw accessError;
        installCheckpoint(entry, presentationState(value, entry.id), row.sequence);
        entry.shouts = null;
      } else if (unchanged && row.sequence > entry.checkpointCursor) {
        installCheckpoint(entry, { ...entry.state }, row.sequence);
      }
      if (row.sequence < entry.checkpointCursor) return;
      entry.pages = page;
      const history = historyFor(entry);
      history.queue(page, row.sequence);
      if (entry.state) entry.state.historyProgress = history.status();
      if (rendered) history.start();
      return;
    }
    const plain = await withBrowserDeadline(() => unseal(entry.key, transportBytes(row.sealed), { boardId: entry.id, kind: 'snapshot', sequence: row.sequence }));
    const value = await snapshotDocument(plain);
    const state = snapshotState(value, entry.id);
    if (accessLost) throw new Error('Sign in again to read this board.');
    entry.snapshotTag = response.headers.get('etag');
    if (row.sequence >= entry.checkpointCursor) {
      entry.history?.close(); entry.history = null; entry.pages = null; entry.pageCache?.clear();
      installCheckpoint(entry, state, row.sequence);
      entry.shouts = Array.isArray(value.presentation?.shouts) ? value.presentation.shouts : null;
    }
  }

  /** Apply a sealed presentation in strict sequence; newer executable formats are never guessed. */
  async function receive(entry, row, history = false) {
    if (!row || !Number.isSafeInteger(row.event_id) || !['move', 'request'].includes(row.kind)) throw new Error('The relay event is invalid. Refresh this board.');
    if (row.event_id <= entry.cursor) return;
    if (row.event_id !== entry.cursor + 1) {
      if (history) throw new Error('The relay returned an incomplete event prefix. Refresh this board.');
      await catchUp(entry);
      if (row.event_id <= entry.cursor) return;
      if (row.event_id !== entry.cursor + 1) throw new Error('The relay event prefix is incomplete. Refresh this board.');
    }
    const plain = await withBrowserDeadline(() => unseal(entry.key, transportBytes(row.sealed), { boardId: entry.id, kind: row.kind, sequence: row.event_id }));
    const move = JSON.parse(new TextDecoder().decode(plain));
    if (accessLost) throw new Error('Sign in again to read this board.');
    if (row.kind === 'request') {
      let request;
      let error;
      try {
        request = validatePersonRequest(move);
        if (row.sender?.kind !== 'person' || typeof row.sender.userId !== 'string' || !row.sender.userId) throw new Refused('RELAY_PERSON_ONLY', 'Only the authenticated person sends requests. Sign in with the person session.');
      } catch (cause) { if (!(cause instanceof Refused)) throw cause; error = { code: cause.code, message: cause.message, next: 'Read the reason and send a revised request from the view.' }; }
      const record = { id: request?.id ?? 'refused-' + row.event_id, sequence: row.event_id, at: row.event_at,
        by: row.sender?.kind === 'person' ? 'person' : row.sender?.agent ?? '(unknown sender)',
        move: request?.move ?? null, status: error ? 'refused' : 'waiting', ...(error ? { error } : {}) };
      entry.state.personRequests ??= [];
      if (!entry.state.personRequests.some(value => value.id === record.id)) entry.state.personRequests.push(record);
      entry.cursor = row.event_id;
      return;
    }
    if (move.version !== 1 || !Number.isSafeInteger(move.engine) || move.engine < 1) throw new Error('This sealed move has an unsupported format. Refresh it from a linked machine.');
    if (move.engine !== ENGINE_VERSION) throw new Refused('RELAY_ENGINE_VERSION', 'This board needs engine ' + move.engine + '; this browser reads engine ' + ENGINE_VERSION + '. Upgrade the browser client.');
    if (move.presentation) {
      entry.history?.close(); entry.history = null; entry.pages = null; entry.pageCache?.clear();
      installCheckpoint(entry, presentationState(move.presentation, entry.id), row.event_id);
      entry.shouts = Array.isArray(move.presentation.shouts) ? move.presentation.shouts : null;
      entry.cursor = row.event_id;
    } else {
      const title = move.args?.find(value => value && typeof value === 'object' && typeof value.title === 'string')?.title;
      entry.pendingSince ??= new Map();
      entry.pendingSince.set(row.event_id, Date.now());
      entry.state.pendingEvents ??= [];
      entry.state.pendingEvents.push({ sequence: row.event_id, operation: move.operation ?? move.event?.event_kind ?? 'move', ...(title ? { title } : {}) });
      entry.cursor = row.event_id;
      pendingCheckpoint(entry);
    }
  }

  /** Read board events without turning board-local snapshot loss into a session redirect. */
  async function boardEvents(entry) {
    try {
      return await documentAt('/api/v1/boards/' + entry.id + '/events?after=' + entry.cursor, denied);
    } catch (error) {
      if (['NO_BOARD', 'NO_SNAPSHOT'].includes(error?.code)) waitForFirstSnapshot(entry);
      throw error;
    }
  }

  /** Read any durable prefix before attaching the live stream, including compaction repair. */
  async function catchUp(entry) {
    try { return await readCompletePrefix(entry); }
    catch (error) {
      if (!access.signal.aborted) { recordBrowserReadFailure(degradedBoards, entry.id); notice(); }
      throw error;
    }
  }

  /** Validate every received sealed event before this board can recover its local health. */
  async function readCompletePrefix(entry) {
    let document;
    try { document = await boardEvents(entry); }
    catch (error) {
      if (!error.message.includes('[SNAPSHOT_REQUIRED]')) throw error;
      await snapshot(entry);
      document = await boardEvents(entry);
    }
    warning(document.warning, entry.id);
    for (const value of document.warnings ?? []) warning(value, entry.id);
    for (const row of document.events) await receive(entry, row, true);
    clearBrowserReadFailure(degradedBoards, entry.id);
    if (failureBoard === entry.id) { failure = ''; failureBoard = null; }
  }

  /** Handle a relay stream message in sequence, matching EventSource behavior with an engine header. */
  async function streamMessage(entry, message, stream) {
    if (!message.data) return;
    const document = JSON.parse(message.data);
    if (message.event === 'warning') { warning(document.warning, entry.id); return; }
    if (message.event === 'error') {
      stream.close();
      const error = document.error;
      if (error?.code === 'DEVICE_REVOKED') { await denied(error); return; }
      if (error?.code === 'SNAPSHOT_REQUIRED') {
        await snapshot(entry);
        await catchUp(entry);
        subscribe(entry);
        onUpdate();
      } else {
        if (['NO_BOARD', 'NO_SNAPSHOT'].includes(error?.code)) {
          waitForFirstSnapshot(entry);
          return;
        }
        if (['AUTH_REQUIRED', 'NO_REPO_ACCESS', 'TOKEN_BOARD'].includes(error?.code)) await documentAt('/api/v1/devices/session', denied);
        failure = error ? relayFailureText(error) : 'The relay stream ended. Refresh this board.';
        failureBoard = entry.id;
        recordBrowserReadFailure(degradedBoards, entry.id);
        notice();
      }
      return;
    }
    if (document.version !== 1) throw new Error('Upgrade this browser client to read the relay API.');
    await receive(entry, document.event);
    // One event is not a successful full read, and cannot clear another board's failure.
    notice();
    onUpdate();
  }

  /** Subscribe to real relay events with an explicit engine declaration and no bearer token or key. */
  function subscribe(entry) {
    entry.stream?.close();
    const controller = new AbortController();
    const stream = { closed: false, close: closeStream };
    /** Abort this stream once so pagehide and authorization loss stop network reads promptly. */
    function closeStream() { stream.closed = true; controller.abort(); }
    entry.stream = stream;
    entry.queue ??= Promise.resolve();
    void followStream({
      url: () => '/api/v1/boards/' + entry.id + '/events?after=' + entry.cursor,
      signal: controller.signal,
      request: async (url, signal) => {
        const response = await realRelayAdapter.request(url, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
          headers: { 'x-pullboard-engine': String(ENGINE_VERSION), accept: 'text/event-stream' },
        });
        if (!response.ok) {
          let document;
          try { document = await response.json(); } catch { document = null; }
          await checkAuthorization(url, response.status, denied, document?.error);
          if (document?.error?.code === 'NO_BOARD' || document?.error?.code === 'NO_SNAPSHOT') waitForFirstSnapshot(entry);
          const refusal = new Refused(document?.error?.code ?? 'RELAY_UNAVAILABLE', document?.error?.message ?? 'The relay stream ended. Refresh this board.');
          if (refusal.code === 'ENGINE_VERSION') refusal.fatal = true;
          throw refusal;
        }
        return response;
      },
      onMessage: message => enqueueStream(entry, () => streamMessage(entry, message, stream)),
      onFailure: (error, { fatal }) => {
        if (controller.signal.aborted || accessLost) return;
        if (['NO_BOARD', 'NO_SNAPSHOT'].includes(error?.code)) { waitForFirstSnapshot(entry); return; }
        failure = relayFailureText(error);
        failureBoard = entry.id;
        recordBrowserReadFailure(degradedBoards, entry.id);
        notice();
        if (fatal) stream.close();
      },
    });
  }

  /** Reauthorize the listing, pair only visible boards, and close streams for lost access. */
  async function listing() {
    const document = await documentAt('/api/v1/boards', denied);
    if (accessLost) throw accessError;
    pendingLinks = [];
    pendingLinksFailure = '';
    try {
      const pending = await documentAt('/api/v1/devices/approvals', denied);
      pendingLinks = Array.isArray(pending.links) ? pending.links.filter(link => typeof link?.name === 'string' && link.name.trim()) : [];
    } catch {
      if (accessLost) throw accessError;
      pendingLinksFailure = 'Phone approval status could not be checked. Refresh to retry.';
    }
    if (accessLost) throw accessError;
    const device = await deviceBoardKeyState((path, options) => documentAt(path, denied, options));
    if (accessLost) throw accessError;
    exclusions = [];
    exclusionsFailure = '';
    try { exclusions = await deviceExcludedBoards((path, options) => documentAt(path, denied, options)); }
    catch {
      if (accessLost) throw accessError;
      exclusionsFailure = 'Excluded-board status could not be checked. Refresh to retry.';
    }
    if (accessLost) throw accessError;
    Object.assign(keys, stored(localStorage, KEYS, {}), device.keys);
    browserPaired = device.paired || Boolean(pair) || Object.values(keys).some(value => {
      try { decodeBoardKey(value); return true; } catch { return false; }
    });
    if (device.failure) { failure = device.failure; failureBoard = null; }
    available = document.boards.filter(board => BOARD.test(board.id) && typeof board.repository === 'string');
    inventoryLoaded = true;
    waitingBoards = new Map();
    sizeProblems = new Map();
    warnings = document.warnings ?? [];
    const visible = new Set(available.map(board => board.id));
    for (const [id, entry] of paired) if (!visible.has(id)) { entry.stream?.close(); entry.history?.close(); entry.pageCache?.clear(); paired.delete(id); }
    for (const board of available) {
      const encoded = pair?.board === board.id ? pair.key : keys[board.id];
      if (paired.has(board.id) && pair?.board !== board.id && encodeBoardKey(paired.get(board.id).key) === encoded) continue;
      if (!encoded) continue;
      try {
        const entry = { id: board.id, repository: board.repository, key: decodeBoardKey(encoded), cursor: -1, checkpointCursor: -1, state: null, shouts: null, outbox: null };
        await snapshot(entry);
        sizeProblems.delete(board.id);
        await catchUp(entry);
        if (accessLost) throw new Error('Sign in again to read this board.');
        paired.get(board.id)?.stream?.close(); paired.get(board.id)?.history?.close(); paired.get(board.id)?.pageCache?.clear();
        paired.set(board.id, entry);
        if (rendered) entry.history?.start();
        waitingBoards.delete(board.id);
        keys[board.id] = encoded;
        try {
          localStorage.setItem(KEYS, JSON.stringify({ ...stored(localStorage, KEYS, {}), [board.id]: encoded }));
          keepPairingStorage();
        } catch { failure = 'This browser cannot save pairing. Use the pairing link again on your next visit.'; failureBoard = null; }
        if (pair?.board === board.id) {
          pair = null;
          try { sessionStorage.removeItem(PENDING); } catch { /* Device storage can be unavailable. */ }
        }
        subscribe(entry);
        pendingCheckpoint(entry);
      } catch (error) {
        if (['NO_BOARD', 'NO_SNAPSHOT'].includes(error?.code) || /\[(?:NO_BOARD|NO_SNAPSHOT)\]/u.test(error.message)) {
          waitForFirstSnapshot({ id: board.id, repository: board.repository });
          continue;
        }
        failure = ['ENGINE_VERSION', 'RELAY_ENGINE_VERSION', 'RELAY_UNAVAILABLE', 'DEVICE_STORAGE'].includes(error.code) || /^\[(?:ENGINE_VERSION|RELAY_ENGINE_VERSION)\]/u.test(error.message)
          ? relayFailureText(error)
          : 'Could not open this board with its saved key. Pair this browser again from a linked machine.';
        failureBoard = board.id;
      }
    }
    notice();
    return {
      version: 1, boards: available.filter(board => paired.has(board.id)).map(board => ({ id: board.id, root: board.id, name: board.repository, project: board.repository })), warnings: [],
    };
  }

  /** Save only ciphertext on the device so an interrupted send retains its stable request id. */
  function saveOutbox(entry) {
    try {
      if (entry.outbox) {
        localStorage.setItem(OUTBOX + entry.id + '.' + entry.outbox.id, JSON.stringify(entry.outbox));
        rememberOwnedRequestId(localStorage, OWNED + entry.id, entry.outbox.id);
      }
    } catch { throw new Refused('REQUEST_STORAGE', 'This browser cannot save the sealed request. Enable device storage before sending it.'); }
    notice();
  }

  /** Read each independently saved request so another tab cannot overwrite or clear its intent. */
  function pendingRequests(entry) {
    const values = [];
    try {
      const prefix = OUTBOX + entry.id + '.';
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) {
          const value = stored(localStorage, key, null);
          if (!value || typeof value.id !== 'string' || key !== prefix + value.id) throw new Error('invalid saved request');
          values.push(value);
        }
      }
    } catch { throw new Refused('REQUEST_STORAGE', 'The browser cannot read its saved sealed requests. Restore device storage before sending again.'); }
    return values.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  /** Remove only the acknowledged request's storage entry, preserving another tab's pending intent. */
  function acknowledge(entry, id) {
    try { localStorage.removeItem(OUTBOX + entry.id + '.' + id); }
    catch { throw new Refused('REQUEST_STORAGE', 'The request was received, but device storage could not record that acknowledgement. Retry this board.'); }
    entry.outbox = null;
  }

  /** Reconcile previously authorized sealed sends before returning state or accepting another action. */
  async function flushOutbox(entry) {
    for (const pending of pendingRequests(entry)) {
      entry.outbox = pending;
      await sendOutbox(entry);
    }
  }

  /** Serialize browser reads, sends and live events through the same per-board cursor owner. */
  function enqueue(entry, work) {
    return enqueueStream(entry, work);
  }

  /** Resolve one addressed shout from this paired device's complete sealed presentation. */
  async function addressedShout(entry, rawId) {
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
      throw new Refused('BAD_REQUEST', 'shout needs a positive integer id; use the id from the event or recent state');
    }
    const id = Number(rawId);
    if (entry.pages) return { version: 1, shout: entry.history?.shout(id) ?? await entry.pages.shout(id) };
    if (!Array.isArray(entry.shouts)) {
      throw new Refused('SHOUT_NOT_AVAILABLE', 'this snapshot does not include addressed shout history; refresh it with a current CLI');
    }
    const found = entry.shouts.find(shout => shout.shout_id === id);
    if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
    const answer = found.shout_decision ? entry.shouts.find(shout => shout.shout_answers === id) ?? null : null;
    return { version: 1, shout: { ...found,
      decision_state: found.shout_decision ? (answer ? 'answered' : 'open') : null,
      decision_answer: answer } };
  }

  /** Seal an unchanged intent at its current public sequence after another client wins the order. */
  async function requestEnvelope(entry, value, sequence) {
    const bytes = await withBrowserDeadline(() => seal(entry.key, new TextEncoder().encode(JSON.stringify(value)), { boardId: entry.id, kind: 'request', sequence }));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { id: value.id, sequence, sealed: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') };
  }

  /** Send a durable opaque intent, repairing order collisions without creating another request. */
  async function sendOutbox(entry) {
    const pending = entry.outbox;
    if (!pending) return null;
    const plain = await withBrowserDeadline(() => unseal(entry.key, transportBytes(pending.sealed), { boardId: entry.id, kind: 'request', sequence: pending.sequence }));
    const value = validatePersonRequest(JSON.parse(new TextDecoder().decode(plain)));
    if (value.id !== pending.id) throw new Refused('REQUEST_STORAGE', 'The saved request is inconsistent. Pair this browser again.');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await snapshot(entry);
      await catchUp(entry);
      const received = entry.state.personRequests?.find(record => record.id === value.id);
      if (received) { acknowledge(entry, value.id); notice(); return { version: 1, event: null, result: { request: received } }; }
      if (entry.outbox.sequence !== entry.cursor + 1) {
        entry.outbox = await requestEnvelope(entry, value, entry.cursor + 1);
        saveOutbox(entry);
      }
      const envelope = entry.outbox;
      let response;
      try {
        const presence = presences.get(value.id);
        response = await documentAt('/api/v1/boards/' + entry.id + '/requests', denied, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence: envelope.sequence, sealed: envelope.sealed, ...(presence ? { presence } : {}) }),
        });
      } catch (error) { if (['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(error.code)) continue; throw error; }
      if (response.event?.event_id !== envelope.sequence || response.event.kind !== 'request' || response.event.sealed !== envelope.sealed) throw new Refused('RELAY_RESPONSE', 'The relay acknowledgement differs from this request. Retry this board.');
      await receive(entry, response.event);
      const record = entry.state.personRequests.find(request => request.id === value.id);
      if (!record) throw new Refused('RELAY_RESPONSE', 'The request acknowledgement has no receipt. Retry this board.');
      acknowledge(entry, value.id);
      presences.delete(value.id);
      notice();
      onUpdate();
      return { version: 1, event: response.event, result: { request: structuredClone(record) } };
    }
    throw new Refused('RELAY_BUSY', 'Other clients kept winning the relay order. Retry this saved request.');
  }

  /**
   * After this phone approves a link, list again until the computer's sealed key arrives, so the
   * board opens here without another pairing. The wait ends at the approval's own expiry.
   */
  async function openApprovedBoard(context) {
    if (context?.action !== 'link') { await listing(); onUpdate(); return; }
    approvedBoards.add(context.board);
    try {
      while (!accessLost && Date.now() < context.expires) {
        await listing(); onUpdate();
        if (paired.has(context.board)) {
          await onOpenBoard(context.board);
          return;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 500));
      }
    } finally { approvedBoards.delete(context.board); notice(); }
  }

  /** Discard expired enrollment without withholding an already authorized browser's boards. */
  async function pairAndList() {
    try {
      if (await enrollPhone((path, options) => documentAt(path, denied, options))) keepPairingStorage();
    } catch (error) {
      if (error?.code !== 'DEVICE_PAIR_EXPIRED') throw error;
      try { await listing(); }
      catch { // Preserve the actionable expiry unless normal authorization detected access loss.
        if (accessLost) throw accessError;
        throw error;
      }
      if (browserPaired) return;
      throw error;
    }
    await listing();
  }

  /** Pair a link opened in this already-loaded page as well as one opened on a fresh visit. */
  async function pairingChanged() {
    try {
      rememberPairing(); pair = takePairing() ?? pair;
      await pairAndList(); onUpdate();
    }
    catch { failure = 'The pairing link is invalid. Get a new link from a linked machine.'; failureBoard = null; notice(); }
  }
  addEventListener('hashchange', pairingChanged);
  // A pairing link opened in another tab, as a scanned QR does, saves its key here: this page fills in by itself.
  addEventListener('storage', event => { if (event.key === KEYS && !accessLost) listing().then(onUpdate, notice); });
  addEventListener('pagehide', () => { access.abort(); for (const entry of paired.values()) { entry.stream?.close(); entry.history?.close(); entry.pageCache?.clear(); } });
  // Keep the first screen while inventory is unknown; a pending read is not evidence that nothing is linked.
  let devicePairing = /(?:^#|&)device=/u.test(location.hash);
  try { devicePairing ||= sessionStorage.getItem('pullboard.relay.device-pair.v1') !== null; } catch { /* No storage: no saved pairing. */ }
  if (!pair && !devicePairing && !Object.keys(keys).length) showRelayScreen(document.documentElement, 'share');
  try {
    await pairAndList();
  } catch (error) {
    if (accessLost) throw accessError;
    failure = error.message || 'Your boards did not open. Try opening this page again.';
    notice();
    throw error;
  }
  // Requests are a separate background feed, not a prerequisite for handing a readable board to the cockpit.
  void installPhoneApprovals((path, options) => documentAt(path, denied, { ...options, signal: access.signal }),
    keys, openApprovedBoard, access.signal).catch(() => {
    if (!accessLost) phoneApprovalStatus(document, 'Requests from your computer did not load. Open this page again to retry.');
  });
  /**
   * Seal and send one person request. While the board signs person moves, a passkey confirms this exact request first,
   * with the person present; its answer rides with the send and is never stored [E22].
   */
  function sendPersonRequest(entry, value) {
    return enqueue(entry, async () => {
      await flushOutbox(entry);
      await snapshot(entry); await catchUp(entry);
      // A signed row decision names the exact text of each row this page shows; the passkey confirms that text.
      if (entry.state.personSigning?.signed && ['spec-approve', 'spec-decline', 'spec-answer'].includes(value.move.verb) && !value.rows) {
        const ids = value.move.verb === 'spec-answer' ? [value.move.args.row] : value.move.args.ids.split(/[\s,]+/u).filter(Boolean);
        const rows = ids.map(id => entry.state.personRows?.find(row => row.id === id));
        if (rows.some(row => !row || typeof row.source !== 'string')) throw new Refused('STALE_ROW_DECISION', 'Refresh this board to read each exact row, gate and signer list before confirming.');
        value = preparePersonRequest(value.move, value.id, rows);
      }
      if (entry.state.personSigning?.signed && ['add', 'edit', 'bar-sign'].includes(value.move.verb) && !value.effect) {
        value = preparePersonRequest(value.move, value.id, value.rows, browserPersonBarEffect(entry.state, value.move));
      }
      if (entry.state.personSigning?.signed && !presences.has(value.id)) {
        presences.set(value.id, await passkeyPresence((path, options) => documentAt(path, denied, { ...options, signal: access.signal }), entry.id, value));
      }
      entry.outbox = await requestEnvelope(entry, value, entry.cursor + 1);
      saveOutbox(entry);
      return sendOutbox(entry);
    });
  }
  installPersonPasskeys(document, { documentAt: (path, options) => documentAt(path, denied, { ...options, signal: access.signal }),
    boards: () => [...paired.values()], signal: access.signal,
    confirm: (board, proposal) => sendPersonRequest(paired.get(board), preparePersonRequest(proposal.move, proposal.id, proposal.rows, proposal.effect)) });
  return {
    /** The plain words and next step for a failed read, for the page's footer line. */
    faultWords: relayFailureText,
    /** Give the startup frame back only after an opted-in viewer has drawn a readable board. */
    didRender() { rendered = true; notice(); for (const entry of paired.values()) entry.history?.start(); },
    /** The View can paint loading counts without making another relay request. */
    historyProgress(boardId) { return paired.get(boardId)?.history?.status() ?? { loaded: 0, total: 0, complete: true, sequence: paired.get(boardId)?.cursor ?? null }; },
    /** Return decoded API state or seal narrow person intent; no board key or plaintext leaves the device. */
    async request(path, body) {
      if (accessLost) throw accessError;
      const url = new URL(path, location.origin);
      if (url.origin !== location.origin) throw new Error('Use this relay origin to read a board.');
      if (url.pathname === '/api/v1/boards') { if (body !== undefined && body !== null) throw new Refused('BAD_REQUEST', 'Send person intent to a paired board.'); return listing(); }
      const match = /^\/api\/v1\/boards\/([0-9a-f]{32})\/(state|events|moves|requests)$/.exec(url.pathname);
      const shoutMatch = /^\/api\/v1\/boards\/([0-9a-f]{32})\/shouts\/([^/]+)$/.exec(url.pathname);
      const itemMatch = /^\/api\/v1\/boards\/([0-9a-f]{32})\/items(?:\/([^/]+))?$/.exec(url.pathname);
      const route = match ?? shoutMatch ?? itemMatch;
      const entry = route && paired.get(route[1]);
      if (!entry) throw new Error('Pair this browser to read that board.');
      if (body !== undefined && body !== null) {
        if (shoutMatch || itemMatch) throw new Refused('BAD_REQUEST', 'Read item or shout detail with GET; send person intent to the board moves endpoint.');
        if (!['moves', 'requests'].includes(match[2])) throw new Refused('BAD_REQUEST', 'Send person intent to this board’s moves endpoint.');
        return sendPersonRequest(entry, preparePersonRequest(body));
      }
      if (itemMatch) return enqueue(entry, async () => {
        await flushOutbox(entry); await snapshot(entry); await catchUp(entry);
        if (!itemMatch[2]) {
          const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
          const ids = entry.pages ? await entry.pages.searchItems(query) : entry.state.items.filter(item =>
            ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase().includes(query)).map(item => item.id);
          return { version: 1, ids };
        }
        if (!/^[1-9]\d*$/u.test(itemMatch[2]) || !Number.isSafeInteger(Number(itemMatch[2]))) throw new Refused('BAD_REQUEST', 'Read an item by its positive integer id.');
        const id = Number(itemMatch[2]);
        const item = entry.pages ? entry.history?.item(id) ?? await entry.pages.item(id) : entry.state.items.find(value => value.id === id);
        if (!item) throw new Refused('NO_ITEM', `no item #${id}`);
        return { version: 1, item };
      });
      if (shoutMatch) {
        return enqueue(entry, async () => {
          await flushOutbox(entry);
          await snapshot(entry);
          await catchUp(entry);
          return addressedShout(entry, shoutMatch[2]);
        });
      }
      if (!['state', 'events'].includes(match[2])) throw new Refused('BAD_REQUEST', 'Read this board’s state or events endpoint.');
      return enqueue(entry, async () => {
        await flushOutbox(entry);
        await snapshot(entry);
        await catchUp(entry);
        // A read has authenticated the checkpoint and complete prefix before clearing its failure.
        if (failureBoard === entry.id) { failure = ''; failureBoard = null; }
        if (entry.stream?.closed) subscribe(entry);
        notice();
        if (match[2] === 'state') return { version: 1, state: entry.state };
        return { version: 1, events: [...entry.state.events].reverse() };
      });
    },
  };
}
