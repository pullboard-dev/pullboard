/**
 * The board-state materializer: a worker thread keeps every read board's state built, extending its last build
 * from the board's new events, while the request thread serves the latest materialized text [A2,C7]. Why a
 * thread: a build on a large board takes seconds, and on the request thread every read behind it waited. Each
 * record carries the board's cheap state revision from before its build. A read whose board still has that revision
 * joins the materialized JSON around its own unread count and starts no rebuild of the board, though it waits for a
 * build that stamps its own clock readings; a read after a change waits for the build that extends the last one with it, so a read never serves state from before a write it follows [A2,C7].
 */
import { Worker } from 'node:worker_threads';

/** How long after a build lands, at least, before another build of a board still being read starts. */
const BUILD_GAP_MS = 250;
/** How many sequences a board's clients hold that its deltas start from, most recently sent kept. */
const HELD_SEQUENCES = 24;

/** The error a worker reported, as a Refused when it was one, so a refusal still reaches the caller by name. */
function workerError(error, Refused) {
  if (error?.name === 'Refused' && typeof error.code === 'string') {
    const prefix = `[${error.code}] `;
    return new Refused(error.code, String(error.message).startsWith(prefix) ? String(error.message).slice(prefix.length) : String(error.message), error.next);
  }
  return Object.assign(new Error(error?.message ?? 'the state worker failed'), { stack: error?.stack });
}

/** How many of a board's shouts, by sorted id, come after `seen`. */
function shoutsAfter(ids, seen) {
  let low = 0, high = ids.length;
  while (low < high) { const middle = (low + high) >>> 1; if (ids[middle] <= seen) low = middle + 1; else high = middle; }
  return ids.length - low;
}

/** Join one materialized text around a read's unread count. */
function joined(parts, unseen) {
  return parts[0] + JSON.stringify(unseen) + parts[1];
}

/**
 * Start the materializer for one API server.
 *
 * @param {{ portsModule: string, projects: () => any[], scope?: { projectRoot: string }, isMain?: boolean, openRevision: (board: object) => { revision: () => string, close?: Function }, onStateBuild?: Function, onRecord?: Function, onFailure?: Function, Refused: Function }} options
 * portsModule names a module whose boardStatePorts() gives the worker its view projections and board openers.
 * openRevision opens a board's cheap revision watcher, the one change notices use, kept open per board.
 * The worker runs until close(), which the server's own close calls.
 */
export function startStateMaterializer({ portsModule, projects, scope, isMain, openRevision, onStateBuild, onRecord, onFailure, Refused }) {
  // The worker takes none of this process's preloads: a test runner's per-file preload, run again in a thread,
  // claimed the file's test slot a second time and killed the worker, so every state read failed [C7].
  const { NODE_TEST_CONTEXT: _testContext, ...workerEnv } = process.env;
  const worker = new Worker(new URL('./materializer/worker.js', import.meta.url), { workerData: { portsModule, scope, isMain, projects: projects() }, execArgv: [], env: workerEnv });
  const boards = new Map();
  let failure = null;
  let closing = false;
  let nextId = 0;

  /** The materializer's record of one board, made on its first read. */
  function boardEntry(board) {
    const key = board.id + '\0' + board.root;
    let entry = boards.get(key);
    if (!entry) boards.set(key, entry = { key, board: { id: board.id, root: board.root }, record: null, inflight: null, again: false, full: false, waiters: [], held: new Map(), timer: null, watcher: null, wanted: null });
    return entry;
  }
  /** The board's state revision now, or null when it cannot be read: a null never matches, so the read waits for a build. */
  function revisionOf(entry) {
    try {
      entry.watcher ??= openRevision(entry.board);
      const value = entry.watcher.revision();
      return typeof value === 'string' ? value : null;
    } catch {
      try { entry.watcher?.close?.(); } catch { /* A failed watcher is reopened on the next read. */ }
      entry.watcher = null;
      return null;
    }
  }
  /** Ask the worker to build a board now, or once its build in flight lands. */
  function request(entry) {
    if (failure) return;
    if (entry.inflight !== null) { entry.again = true; return; }
    if (entry.timer) return;
    entry.again = false;
    entry.inflight = ++nextId;
    let current;
    try { current = projects(); } catch { current = undefined; }
    worker.postMessage({ type: 'build', id: entry.inflight, key: entry.key, board: entry.board, held: [...entry.held.keys()], full: entry.full, revision: entry.wanted, projects: current });
  }
  /**
   * Settle every waiting read the record satisfies: one built from a request sent after the read, so it saw what the
   * read saw, or a restored one saved at the very revision the read found.
   */
  function settle(entry, id) {
    const waiting = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiting) {
      const fresh = id === undefined ? waiter.revision !== null && entry.record.revision === waiter.revision : id > waiter.after;
      if (fresh && (!waiter.full || entry.record.full)) waiter.ok(entry.record);
      else entry.waiters.push(waiter);
    }
  }
  worker.on('message', (message) => {
    if (message.type === 'build') { onStateBuild?.({ board: message.board, full: message.full }); return; }
    const entry = message.board ? boardEntry(message.board) : boards.get(message.key);
    if (!entry) return;
    if (message.type === 'record') {
      entry.record = message.record;
      if (!message.restored && message.id === entry.inflight) entry.inflight = null;
      settle(entry, message.restored ? undefined : message.id);
      onRecord?.({ board: entry.board.id, restored: Boolean(message.restored), sequence: message.record.sequence });
    } else if (message.type === 'error') {
      if (message.id === entry.inflight) entry.inflight = null;
      const waiting = entry.waiters;
      entry.waiters = [];
      for (const waiter of waiting) waiter.fail(workerError(message.error, Refused));
    }
    if (entry.inflight === null && (entry.again || entry.waiters.length)) {
      entry.timer = setTimeout(() => { entry.timer = null; request(entry); }, entry.waiters.length ? 0 : BUILD_GAP_MS);
    }
  });
  /** Stop serving from the worker for good: every waiting read fails over to the request thread's own build. */
  function stopped(error) {
    if (failure || closing) return;
    failure = error;
    onFailure?.(error);
    for (const entry of boards.values()) { for (const waiter of entry.waiters) waiter.fail(error); entry.waiters = []; }
  }
  worker.on('error', stopped);
  worker.on('exit', (code) => stopped(new Error(`the state worker exited with code ${code}`)));

  /**
   * A board's record as of this read: the held content while the board's revision is unchanged, restamped with this
   * read's clock readings by a build that rebuilds nothing; otherwise the next build, which extends the last one with the change.
   */
  function latest(board, { full = false } = {}) {
    const entry = boardEntry(board);
    if (full) entry.full = true;
    const revision = revisionOf(entry);
    // A held record carries the clock readings of its build (flow asOf, queue ages): a read after that moment is a
    // new observation of an unchanged board, so it waits for a build that stamps its own [N26]. That build reuses
    // the cached state, so it starts no rebuild of the board.
    if (entry.record && (!full || entry.record.full) && revision !== null && entry.record.revision === revision && entry.record.observedAt >= Date.now()) return entry.record;
    const waiting = new Promise((ok, fail) => entry.waiters.push({ ok, fail, full, revision, after: nextId }));
    entry.wanted = revision;
    request(entry);
    return waiting;
  }
  /** Remember a sequence a client now holds, so the next builds keep a delta from it. */
  function hold(board, sequence) {
    const entry = boardEntry(board);
    entry.held.delete(sequence);
    entry.held.set(sequence, true);
    while (entry.held.size > HELD_SEQUENCES) entry.held.delete(entry.held.keys().next().value);
  }

  return {
    /** Whether the worker still runs; a server whose worker failed reads on the request thread instead. */
    get alive() { return failure === null; },
    /** A state read's JSON, validator and report validator, from the latest materialized record. */
    async stateJson(board, seen, { detail = null, items = null, stateDetail = 'summary' } = {}) {
      const compact = items === 'compact';
      const full = !compact && (detail ?? stateDetail) === 'full';
      const record = await latest(board, { full });
      const unseen = seen === null ? null : { since: seen, count: shoutsAfter(record.shouts, seen) };
      const variant = full ? record.full : compact ? record.compact : record.summary;
      if (!full) hold(board, record.sequence);
      return { json: joined(variant.json, unseen), validator: joined(variant.validator, unseen), reportValidator: record.reportValidator };
    },
    /** A delta read: the change since a held sequence, or a reset naming why there is none. */
    async delta(board, seen, { since, eventLogVersion = null }, refusalDocument) {
      const record = await latest(board);
      const answer = { since, sequence: record.sequence, eventLogVersion: record.eventLogVersion };
      const path = '/api/v1/boards/' + board.id + '/state';
      const reset = (code, message) => Object.defineProperty({ ...answer, delta: null, reset: refusalDocument(new Refused(code, message)).error }, 'reportValidator', { value: record.reportValidator });
      if (eventLogVersion !== null && eventLogVersion !== String(record.eventLogVersion)) {
        return reset('FORMAT_CHANGED', `this server writes event-log format ${record.eventLogVersion}, not ${eventLogVersion}; use GET ${path} for a fresh snapshot`);
      }
      if (since > record.sequence) return reset('BASE_AHEAD', `this board's latest event is ${record.sequence}, before ${since}; use GET ${path} for a fresh snapshot`);
      const parts = Object.hasOwn(record.deltas, since) ? record.deltas[since] : null;
      if (!parts) return reset('BASE_NOT_KEPT', `this server keeps no snapshot it sent at event ${since}; use GET ${path} for a fresh snapshot`);
      hold(board, record.sequence);
      const unseen = seen === null ? null : { since: seen, count: shoutsAfter(record.shouts, seen) };
      return Object.defineProperty({ ...answer, delta: JSON.parse(joined(parts, unseen)) }, 'reportValidator', { value: record.reportValidator });
    },
    /** The ids of the items a search shows, from the latest record's search texts. */
    async search(board, text) {
      const words = String(text).trim().toLowerCase();
      const record = await latest(board);
      return record.search.filter(([, searched]) => !words || searched.includes(words)).map(([id]) => id);
    },
    /** Save each board's latest build and stop the worker. */
    close() {
      for (const entry of boards.values()) {
        clearTimeout(entry.timer);
        try { entry.watcher?.close?.(); } catch { /* Closing a watcher never stops the others closing. */ }
      }
      if (failure) return;
      closing = true;
      worker.postMessage({ type: 'close' });
    },
  };
}
