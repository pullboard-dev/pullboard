/** Device-only relay transport: cookie authorization, local keys and authenticated ciphertext [H5,H15,H16,H17]. */
import { rememberDevicePairing, enrollPhone, deviceBoardKeys, installPhoneApprovals } from './browser-devices.js';
import { decodeBoardKey, encodeBoardKey, seal, unseal } from './seal.js';
import { preparePersonRequest, validatePersonRequest } from './person-request.js';
import { snapshotState, presentationState } from './model.js';
import { ENGINE_VERSION } from './engine.js';
import { Refused } from './refused.js';
import { enqueueStream, followStream } from './browser-stream.js';
import { noticeLines, rememberOwnedRequestId, storedOwnedRequestState } from './browser-notice.js';

const KEYS = 'pullboard.relay.keys.v1';
const PENDING = 'pullboard.relay.pair.v1';
const OUTBOX = 'pullboard.relay.requests.v1.';
const OWNED = 'pullboard.relay.owned-requests.v1.';
const BOARD = /^[0-9a-f]{32}$/;

/** Read private browser storage without turning unavailable storage into a credential diagnostic. */
function stored(storage, name, fallback) {
  try { return JSON.parse(storage.getItem(name)) ?? fallback; } catch { return fallback; }
}

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
  return pair;
}

/** Decode canonical sealed transport bytes without putting their value in an error. */
function transportBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 14000000) throw new Error('The sealed board response is invalid. Refresh this board.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Inflate a new gzip snapshot or preserve the legacy JSON plaintext format. */
async function snapshotDocument(plain) {
  if (plain[0] === 0x1f && plain[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read gzip snapshots. Upgrade the browser client.');
    try {
      const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text());
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
async function checkAuthorization(path, status, onDenied) {
  if (![401, 403].includes(status) || !onDenied) return;
  if (['/api/v1/boards', '/api/v1/devices/session'].includes(new URL(path, location.origin).pathname)) onDenied();
  else await documentAt('/api/v1/devices/session', onDenied);
}

/** Fetch only same-origin API documents, retaining stable refusal guidance and no provider details. */
async function documentAt(path, onDenied, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set('x-pullboard-engine', String(ENGINE_VERSION));
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const document = await response.json();
  if (!response.ok) {
    const error = document.error;
    await checkAuthorization(path, response.status, onDenied);
    if (error) throw new Refused(error.code, error.message);
    throw new Refused('RELAY_UNAVAILABLE', 'The relay did not answer. Sign in again or retry.');
  }
  if (document.version !== 1) throw new Error('This relay API version is unsupported. Upgrade this browser client.');
  return document;
}

/** Build the API adapter the existing cockpit consumes; no board key enters an HTTP request. */
export async function createTransport({ onUpdate = () => {} } = {}) {
  const savedKeys = stored(localStorage, KEYS, {});
  const keys = savedKeys && typeof savedKeys === 'object' && !Array.isArray(savedKeys) ? savedKeys : {};
  const paired = new Map();
  let available = [];
  let waitingBoards = new Map();
  let warnings = [];
  let failure = '';
  let failureBoard = null;
  let accessLost = false;
  let pair = rememberPairing() ?? stored(sessionStorage, PENDING, null);
  if (pair && (!BOARD.test(pair.board ?? '') || typeof pair.key !== 'string')) pair = null;
  try { if (pair) decodeBoardKey(pair.key); } catch { pair = null; }

  /** Discard decrypted memory and this document when relay authorization is lost. */
  function denied() {
    if (accessLost) return;
    accessLost = true;
    for (const entry of paired.values()) { entry.stream?.close(); entry.state = null; }
    paired.clear();
    document.querySelector('main')?.replaceChildren();
    location.replace('/');
  }

  /** Render only authorized board names, safe warnings and pairing guidance into the generic page. */
  function notice() {
    const element = document.getElementById('relay-notice');
    if (!element) return;
    element.replaceChildren();
    const ownedRequestIds = new Map();
    for (const [id, entry] of paired) {
      const key = OWNED + id;
      let state = { owned: new Set() };
      try { state = storedOwnedRequestState(localStorage, key, entry.state?.personRequests); } catch { /* Missing device storage can only hide this device's own notice. */ }
      ownedRequestIds.set(id, state.owned);
    }
    for (const text of noticeLines({ available, paired, ownedRequestIds, waitingBoards, warnings, failure })) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      element.append(paragraph);
    }
  }

  /** Keep one missing-snapshot board visible as waiting without clearing other authorized boards. */
  function waitForFirstSnapshot(entry) {
    entry.stream?.close();
    entry.state = null;
    paired.delete(entry.id);
    const board = available.find(value => value.id === entry.id);
    waitingBoards.set(entry.id, board?.repository ?? entry.repository ?? 'This board');
    notice();
  }

  /** Retain one warning per board without duplicating it on the next live poll. */
  function warning(value, boardId) {
    if (!value || value.code !== 'BOARD_INACTIVE') return;
    warnings = warnings.filter(entry => entry.board !== boardId);
    warnings.push({ ...value, board: boardId });
    notice();
  }

  /** Authenticate the latest native snapshot before installing its presentation in this device. */
  async function snapshot(entry) {
    const response = await fetch('/api/v1/boards/' + entry.id + '/state', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'x-pullboard-engine': String(ENGINE_VERSION), ...(entry.state && entry.snapshotTag ? { 'if-none-match': entry.snapshotTag } : {}) },
    });
    if (response.status === 304 && entry.state) return;
    const document = await response.json();
    if (!response.ok) {
      await checkAuthorization('/api/v1/boards/' + entry.id + '/state', response.status, denied);
      if (document.error?.code === 'NO_BOARD' || document.error?.code === 'NO_SNAPSHOT') waitForFirstSnapshot(entry);
      throw new Error(document.error ? '[' + document.error.code + '] ' + document.error.message : 'The relay snapshot is unavailable. Retry.');
    }
    if (document.version !== 1) throw new Error('This relay API version is unsupported. Upgrade this browser client.');
    const row = document.state;
    if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 0) throw new Error('The relay snapshot cursor is invalid. Refresh this board.');
    warning(row.warning, entry.id);
    const plain = await unseal(entry.key, transportBytes(row.sealed), { boardId: entry.id, kind: 'snapshot', sequence: row.sequence });
    const value = await snapshotDocument(plain);
    const state = snapshotState(value, entry.id);
    if (accessLost) throw new Error('Sign in again to read this board.');
    entry.snapshotTag = response.headers.get('etag');
    if (row.sequence >= entry.cursor) {
      entry.state = state;
      entry.cursor = row.sequence;
    }
  }

  /** Wait for an acknowledged device snapshot instead of consuming an event with no projection. */
  async function waitForSnapshot(entry, sequence) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await snapshot(entry);
      if (entry.state && entry.cursor >= sequence) return;
      await new Promise(resolveSnapshot => setTimeout(resolveSnapshot, 100));
    }
    throw new Error('The relay snapshot has not caught up to this move. Retry this board.');
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
    const plain = await unseal(entry.key, transportBytes(row.sealed), { boardId: entry.id, kind: row.kind, sequence: row.event_id });
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
      entry.state = presentationState(move.presentation, entry.id);
      entry.cursor = row.event_id;
    } else {
      // A snapshot may be uploaded just after this ACK and compact the event immediately. Keep
      // the cursor where it is until a valid snapshot actually covers this row.
      await waitForSnapshot(entry, row.event_id);
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
    let document;
    try { document = await boardEvents(entry); }
    catch (error) {
      if (!error.message.includes('[SNAPSHOT_REQUIRED]')) throw error;
      await snapshot(entry);
      document = await boardEvents(entry);
    }
    warning(document.warning, entry.id);
    for (const row of document.events) await receive(entry, row, true);
  }

  /** Handle a relay stream message in sequence, matching EventSource behavior with an engine header. */
  async function streamMessage(entry, message, stream) {
    if (!message.data) return;
    const document = JSON.parse(message.data);
    if (message.event === 'warning') { warning(document.warning, entry.id); return; }
    if (message.event === 'error') {
      stream.close();
      const error = document.error;
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
        failure = error ? '[' + error.code + '] ' + error.message : 'The relay stream ended. Refresh this board.';
        failureBoard = entry.id;
        notice();
      }
      return;
    }
    if (document.version !== 1) throw new Error('Upgrade this browser client to read the relay API.');
    await receive(entry, document.event);
    failure = '';
    failureBoard = null;
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
        const response = await fetch(url, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
          headers: { 'x-pullboard-engine': String(ENGINE_VERSION), accept: 'text/event-stream' },
        });
        if (!response.ok) {
          let document;
          try { document = await response.json(); } catch { document = null; }
          await checkAuthorization(url, response.status, denied);
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
        failure = error.message;
        failureBoard = entry.id;
        notice();
        if (fatal) stream.close();
      },
    });
  }

  /** Reauthorize the listing, pair only visible boards, and close streams for lost access. */
  async function listing() {
    const document = await documentAt('/api/v1/boards', denied);
    Object.assign(keys, stored(localStorage, KEYS, {}));
    Object.assign(keys, await deviceBoardKeys((path, options) => documentAt(path, denied, options)));
    available = document.boards.filter(board => BOARD.test(board.id) && typeof board.repository === 'string');
    waitingBoards = new Map();
    warnings = document.warnings ?? [];
    const visible = new Set(available.map(board => board.id));
    for (const [id, entry] of paired) if (!visible.has(id)) { entry.stream?.close(); paired.delete(id); }
    for (const board of available) {
      const encoded = pair?.board === board.id ? pair.key : keys[board.id];
      if (paired.has(board.id) && pair?.board !== board.id && encodeBoardKey(paired.get(board.id).key) === encoded) continue;
      if (!encoded) continue;
      try {
        const entry = { id: board.id, repository: board.repository, key: decodeBoardKey(encoded), cursor: -1, state: null, outbox: null };
        await snapshot(entry);
        await catchUp(entry);
        if (accessLost) throw new Error('Sign in again to read this board.');
        paired.get(board.id)?.stream?.close();
        paired.set(board.id, entry);
        waitingBoards.delete(board.id);
        keys[board.id] = encoded;
        try { localStorage.setItem(KEYS, JSON.stringify({ ...stored(localStorage, KEYS, {}), [board.id]: encoded })); } catch { failure = 'This browser cannot save pairing. Use the pairing link again on your next visit.'; failureBoard = null; }
        if (pair?.board === board.id) {
          pair = null;
          try { sessionStorage.removeItem(PENDING); } catch { /* Device storage can be unavailable. */ }
        }
        subscribe(entry);
      } catch (error) {
        if (['NO_BOARD', 'NO_SNAPSHOT'].includes(error?.code) || /\[(?:NO_BOARD|NO_SNAPSHOT)\]/u.test(error.message)) {
          waitForFirstSnapshot({ id: board.id, repository: board.repository });
          continue;
        }
        failure = ['ENGINE_VERSION', 'RELAY_ENGINE_VERSION'].includes(error.code) || /^\[(?:ENGINE_VERSION|RELAY_ENGINE_VERSION)\]/u.test(error.message)
          ? error.message
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

  /** Seal an unchanged intent at its current public sequence after another client wins the order. */
  async function requestEnvelope(entry, value, sequence) {
    const bytes = await seal(entry.key, new TextEncoder().encode(JSON.stringify(value)), { boardId: entry.id, kind: 'request', sequence });
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { id: value.id, sequence, sealed: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') };
  }

  /** Send a durable opaque intent, repairing order collisions without creating another request. */
  async function sendOutbox(entry) {
    const pending = entry.outbox;
    if (!pending) return null;
    const plain = await unseal(entry.key, transportBytes(pending.sealed), { boardId: entry.id, kind: 'request', sequence: pending.sequence });
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
        response = await documentAt('/api/v1/boards/' + entry.id + '/requests', denied, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sequence: envelope.sequence, sealed: envelope.sealed }),
        });
      } catch (error) { if (['SEQUENCE_REPEAT', 'SEQUENCE_GAP'].includes(error.code)) continue; throw error; }
      if (response.event?.event_id !== envelope.sequence || response.event.kind !== 'request' || response.event.sealed !== envelope.sealed) throw new Refused('RELAY_RESPONSE', 'The relay acknowledgement differs from this request. Retry this board.');
      await receive(entry, response.event);
      const record = entry.state.personRequests.find(request => request.id === value.id);
      if (!record) throw new Refused('RELAY_RESPONSE', 'The request acknowledgement has no receipt. Retry this board.');
      acknowledge(entry, value.id);
      notice();
      onUpdate();
      return { version: 1, event: response.event, result: { request: structuredClone(record) } };
    }
    throw new Refused('RELAY_BUSY', 'Other clients kept winning the relay order. Retry this saved request.');
  }

  /** Pair a link opened in this already-loaded page as well as one opened on a fresh visit. */
  async function pairingChanged() {
    try { pair = rememberPairing() ?? pair; await enrollPhone((path, options) => documentAt(path, denied, options)); await listing(); onUpdate(); }
    catch { failure = 'The pairing link is invalid. Get a new link from a linked machine.'; failureBoard = null; notice(); }
  }
  addEventListener('hashchange', pairingChanged);
  addEventListener('pagehide', () => { for (const entry of paired.values()) entry.stream?.close(); });
  await enrollPhone((path, options) => documentAt(path, denied, options));
  await listing();
  await installPhoneApprovals((path, options) => documentAt(path, denied, options), keys, async () => { await listing(); onUpdate(); });
  return {
    /** Return decoded API state or seal narrow person intent; no board key or plaintext leaves the device. */
    async request(path, body) {
      const url = new URL(path, location.origin);
      if (url.origin !== location.origin) throw new Error('Use this relay origin to read a board.');
      if (url.pathname === '/api/v1/boards') { if (body !== undefined && body !== null) throw new Refused('BAD_REQUEST', 'Send person intent to a paired board.'); return listing(); }
      const match = /^\/api\/v1\/boards\/([0-9a-f]{32})\/(state|events|moves|requests)$/.exec(url.pathname);
      const entry = match && paired.get(match[1]);
      if (!entry) throw new Error('Pair this browser to read that board.');
      if (body !== undefined && body !== null) {
        if (!['moves', 'requests'].includes(match[2])) throw new Refused('BAD_REQUEST', 'Send person intent to this board’s moves endpoint.');
        const value = preparePersonRequest(body);
        const send = enqueue(entry, async () => {
          await flushOutbox(entry);
          await snapshot(entry); await catchUp(entry);
          entry.outbox = await requestEnvelope(entry, value, entry.cursor + 1);
          saveOutbox(entry);
          return sendOutbox(entry);
        });
        return send;
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
