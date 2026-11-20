/** A board writer applies moves computed elsewhere, one at a time, so no command holds the board lock while it computes [H24,C7]. */
import { createConnection } from 'node:net';
import { createServer } from 'node:net';
import { Refused } from '../../../../kernel/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** The answer a writer gives a move computed from a snapshot that has since changed. */
const CHANGED = 'changed, retry';
/** Unix socket paths are cut near this many bytes, and a cut path can name another writer's socket. */
const MOST_SOCKET_BYTES = 100;

/** Refuse a socket path the operating system would truncate, so two long paths can never meet at one socket. */
function requireShortSocket(socket) {
  if (Buffer.byteLength(socket) > MOST_SOCKET_BYTES) {
    throw new Refused('BOARD_WRITER_SOCKET', `the board writer socket path is ${Buffer.byteLength(socket)} bytes and the system cuts paths past ${MOST_SOCKET_BYTES}; use a shorter directory`);
  }
}

/**
 * Create the writer's core: a queue that applies each move in arrival order, atomically, or answers `changed, retry`.
 * A command sends the snapshot version it read and the keys its move touches (items, seats). The move is stale only when
 * a touched key was written after that snapshot, so twenty seats writing their own keys never turn each other away.
 *
 * @param {{ apply: (move: any) => any | Promise<any>, version?: number }} options `apply` writes one move and may be async.
 * @returns {{ snapshot: () => number, commit: (request: { snapshot: number, touches?: string[], move: any }) => Promise<{ applied: boolean, version: number, result?: any, changed?: boolean, message?: string }> }}
 */
export function createBoardWriter({ apply, version = 0 }) {
  let sequence = version, tail = Promise.resolve();
  const written = new Map();
  /** Decide and apply one move; the queue guarantees no two decisions interleave. */
  async function decide({ snapshot, touches = [], move }) {
    if (touches.some(key => (written.get(key) ?? 0) > snapshot)) return { applied: false, changed: true, version: sequence, message: CHANGED };
    const result = await apply(move);
    sequence += 1;
    for (const key of touches) written.set(key, sequence);
    return { applied: true, version: sequence, result };
  }
  return {
    snapshot: () => sequence,
    /** Queue the move behind every earlier one. */
    commit(request) {
      const answer = tail.then(() => decide(request));
      tail = answer.catch(() => {});
      return answer;
    },
  };
}

/**
 * Serve a writer on a local socket, one JSON line per request and per reply, so commands in other processes reach it.
 *
 * @param {string} socket path of the Unix socket
 * @param {ReturnType<typeof createBoardWriter>} writer
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export function serveBoardWriter(socket, writer) {
  requireShortSocket(socket);
  fs.rm(socket, { force: true });
  const open = new Set();
  const server = createServer(connection => {
    let buffered = '';
    open.add(connection);
    connection.once('close', () => open.delete(connection));
    connection.setEncoding('utf8');
    connection.on('error', () => {});
    connection.on('data', chunk => {
      buffered += chunk;
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        reply(connection, writer, line);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve({ close: () => new Promise(done => { for (const connection of open) connection.destroy(); server.close(() => { fs.rm(socket, { force: true }); done(); }); }) }));
  });
}

/** Answer one request line; a malformed or failing request gets an error reply and never stops the writer. */
function reply(connection, writer, line) {
  let request;
  try { request = JSON.parse(line); } catch { connection.write(JSON.stringify({ error: 'unreadable request' }) + '\n'); return; }
  const send = answer => connection.write(JSON.stringify({ id: request.id, ...answer }) + '\n');
  if (request.op === 'snapshot') { send({ version: writer.snapshot() }); return; }
  writer.commit(request).then(send, error => send({ error: String(error?.message ?? error) }));
}

/**
 * Connect to a running writer. Rejects with BOARD_WRITER_ABSENT when none is listening.
 *
 * @param {string} socket
 * @returns {Promise<{ snapshot: () => Promise<number>, commit: (request: { snapshot: number, touches?: string[], move: any }) => Promise<any>, close: () => void }>}
 */
export function connectBoardWriter(socket) {
  requireShortSocket(socket);
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    const waiting = new Map();
    let buffered = '', next = 0;
    connection.setEncoding('utf8');
    connection.once('error', error => reject(new Refused('BOARD_WRITER_ABSENT', `no board writer is listening at ${socket} (${error.code ?? error.message}); write the board directly`)));
    connection.on('data', chunk => {
      buffered += chunk;
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const answer = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        const done = waiting.get(answer.id);
        waiting.delete(answer.id);
        if (done) answer.error ? done.reject(new Error(answer.error)) : done.resolve(answer);
      }
    });
    connection.on('close', () => { for (const done of waiting.values()) done.reject(new Refused('BOARD_WRITER_ABSENT', 'the board writer closed the connection; write the board directly')); waiting.clear(); });
    /** Send one request and wait for its reply. */
    const ask = request => new Promise((ok, fail) => { const id = next += 1; waiting.set(id, { resolve: ok, reject: fail }); connection.write(JSON.stringify({ ...request, id }) + '\n'); });
    connection.once('connect', () => {
      connection.removeAllListeners('error');
      connection.on('error', () => {});
      resolve({ snapshot: async () => (await ask({ op: 'snapshot' })).version, commit: request => ask({ op: 'commit', ...request }), close: () => connection.end() });
    });
  });
}

/**
 * Send a move through the writer when one runs; otherwise write it directly, so the board never depends on the writer.
 *
 * @param {{ socket: string, request: { snapshot: number, touches?: string[], move: any }, direct: (move: any) => any | Promise<any> }} options
 * @returns {Promise<{ applied: boolean, direct?: boolean, version?: number, result?: any, changed?: boolean, message?: string }>}
 */
export async function commitMove({ socket, request, direct }) {
  let writer;
  try { writer = await connectBoardWriter(socket); }
  catch (error) {
    if (error?.code !== 'BOARD_WRITER_ABSENT') throw error;
    return { applied: true, direct: true, result: await direct(request.move) };
  }
  try { return await writer.commit(request); }
  finally { writer.close(); }
}
