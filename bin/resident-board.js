#!/usr/bin/env node
/**
 * The resident board process: one per board checkout and CLI entry, started by the thin client on first use. It keeps
 * the CLI's modules loaded and the board open, holding read-only connections that read commands reuse, and runs each
 * forwarded command through apps/cli/src/shell/cli-main.js, the same entry the in-process path uses, so a warm command pays only for
 * its own work [H24,C7].
 *
 * Commands run one at a time, each with its own state: process.env reads and writes go to that command's environment,
 * the real working directory is its own (child processes and relative paths resolve there), and its stdout and stderr,
 * including direct process.stdout writes, stream to its client only. Why one at a time: a warm command takes tens of
 * milliseconds, and following interleaved commands' directories cost every async callback a hook. Each command owns
 * the connection it takes until it closes the board. The process retires, closing every connection, when its code is
 * no longer the entry's code, after an hour, and when idle.
 */
import {
  appendFileSync,
  chmodSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  connect,
  createServer,
} from 'node:net';
import {
  endThen,
  pathIdentity,
  releaseOwnSocket,
} from './resident-socket.js';

// Node 22 announces that node:sqlite is experimental; the in-process entry drops that notice, and so does this one.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

const [socketPath, entry, loadedCode, pidFile] = process.argv.slice(2);
const IDLE_MS = Number(process.env.PULLBOARD_RESIDENT_IDLE_MS) || 15 * 60_000;
const MAX_AGE_MS = Number(process.env.PULLBOARD_RESIDENT_MAX_AGE_MS) || 60 * 60_000;
/** How often a listening process checks that the socket path is still its own. */
const REPLACED_CHECK_MS = Number(process.env.PULLBOARD_RESIDENT_REPLACED_CHECK_MS) || 2_000;
/**
 * The process's clock: wall time, or the milliseconds in the file PULLBOARD_RESIDENT_CLOCK names, so a test can move
 * idle and age time without waiting for it.
 */
function clock() {
  const file = process.env.PULLBOARD_RESIDENT_CLOCK;
  if (file) try { return Number(readFileSync(file, 'utf8')); } catch { /* Fall back to wall time. */ }
  return Date.now();
}
const bornAt = clock();
const baseEnv = process.env;
/** The command running now, or null between commands. */
let running = null;
/** The tail of the queue of commands, each started when the one before it finishes. */
let queue = Promise.resolve();
const inFlight = new Set();
let lastActive = clock();
let retired = false;
/** The identity of the socket file this process bound, so it never unlinks or serves a successor's socket. */
let ownSocket = null;
/** Client responses still being written; a retired process exits only when none are left. */
let flushing = 0;

/** The environment of the command whose code is running, or the process's own between commands. */
const activeEnv = () => running?.env ?? baseEnv;
process.env = new Proxy({}, {
  get: (_, key) => typeof key === 'string' ? activeEnv()[key] : undefined,
  set: (_, key, value) => { if (typeof key === 'string') activeEnv()[key] = String(value); return true; },
  deleteProperty: (_, key) => { delete activeEnv()[key]; return true; },
  has: (_, key) => key in activeEnv(),
  ownKeys: () => Reflect.ownKeys(activeEnv()),
  getOwnPropertyDescriptor: (_, key) => Object.hasOwn(activeEnv(), key)
    ? { value: activeEnv()[key], writable: true, enumerable: true, configurable: true } : undefined,
});

/** Make the real working directory the command's own; false when it no longer exists. */
function enterDirectory(cwd) {
  try { process.chdir(cwd); return true; } catch { return false; }
}

for (const [name, frame] of [['stdout', 'out'], ['stderr', 'err']]) {
  const stream = process[name];
  const write = stream.write.bind(stream);
  /** Route a direct process stream write to the command that made it; between commands it goes nowhere visible. */
  stream.write = (chunk, encoding, callback) => {
    if (!running) return write(chunk, encoding, callback);
    running.send(frame, chunk);
    if (typeof encoding === 'function') encoding(); else if (typeof callback === 'function') callback();
    return true;
  };
}

/** Remove the socket and pid file this process made, leaving a successor's in place. */
function release() {
  // Why: an orphan that unlinks the path deletes its successor's live socket, so every client starts yet another process.
  // The socket goes before the pid file, so a successor never finds the path held with no live holder named.
  releaseOwnSocket(socketPath, ownSocket, String(process.pid));
  try { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile); } catch { /* Already gone. */ }
}

/** The socket path's file identity now, or null when nothing is there. */
const socketIdentity = () => pathIdentity(socketPath);

/** Whether another process now owns the socket path: this one can no longer be reached and must not linger. */
function replaced() {
  return process.platform !== 'win32' && ownSocket !== null && socketIdentity() !== ownSocket;
}

/** Whether the process named by the pid file is alive and is not this one. */
function holderAlive() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) { return error?.code === 'EPERM'; }
}

/** Stop taking commands and free the socket path for a successor now; exitWhenDone ends the process. */
function retire(reason) {
  if (retired) return;
  retired = true;
  trace(`retire:${reason}`, null);
  release();
  // Why no server.close(): Node unlinks a Unix socket's path when its server closes, whoever holds the path by then.
  // With the path released nothing new connects; a connection already queued is answered stale.
  closeConnections();
}

/** Exit a retired process once its running commands have finished and their responses are written. */
function exitWhenDone() {
  if (retired && !inFlight.size && !flushing) process.exit(0);
}

/** Send a client its last line, holding a retired process's exit until the line is written. */
function finish(socket, value) {
  flushing++;
  endThen(socket, JSON.stringify(value) + '\n', () => { flushing--; exitWhenDone(); });
}

const { main, selectedToolEntry } = await import('../apps/cli/src/shell/cli-main.js');
const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import('./process-ports.js');
const { holdReadConnections, openBoardReadOnly } = await import('../packages/store/index.js');
const TRACE = baseEnv.PULLBOARD_RESIDENT_TRACE;
const IDLE_CONNECTIONS = 4;
/** Idle read-only board connections by board file, each with the file identity it was opened on. */
const connections = new Map();

/** Append one line to the opt-in trace a test reads to see connections opened and reused. */
function trace(event, file) {
  if (TRACE) try { appendFileSync(TRACE, JSON.stringify({ event, file, pid: process.pid }) + '\n'); } catch { /* Tracing never changes a command. */ }
}

/** The identity of a board file now; a replaced file is a different board, whatever its path. */
function fileIdentity(file) {
  try { const stat = statSync(file); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}

/** Really close a held connection. */
function closeConnection(entry) {
  try { entry.close(); } catch { /* Already closed. */ }
}

/**
 * Take a read-only connection this process holds for the board, or open one. A command owns the connection it takes
 * until it closes the board, so concurrent commands never share one; closing returns it here instead.
 */
function takeConnection(file) {
  const identity = fileIdentity(file);
  const idle = connections.get(file) ?? [];
  while (idle.length) {
    const entry = idle.pop();
    if (entry.identity === identity) { entry.idle = false; trace('reuse', file); return entry.db; }
    closeConnection(entry);
  }
  const db = openBoardReadOnly(file);
  const close = db.close.bind(db);
  const entry = { db, identity, close };
  // The command's closeBoard ends any read it left open and gives the connection back for the next command.
  db.close = () => {
    // A second close of one command's board must not hand the same connection to two later commands.
    if (entry.idle) return;
    try { db.exec('ROLLBACK'); } catch { /* No read transaction was open. */ }
    const held = connections.get(file) ?? [];
    if (retired || held.length >= IDLE_CONNECTIONS || fileIdentity(file) !== entry.identity) return close();
    entry.idle = true;
    held.push(entry);
    connections.set(file, held);
  };
  trace('open', file);
  return db;
}

/** Close every connection this process holds, when it retires. */
function closeConnections() {
  for (const [file, idle] of connections) for (const entry of idle) { closeConnection(entry); trace('close', file); }
  connections.clear();
}

// Every read open in this process, whichever module asks, takes a connection the process holds.
holdReadConnections(takeConnection);

const { gitLocation, headCommit } = await import('./resident-client.js');
/** Boards found to run this entry rather than a pinned build, by board, main commit and published selection. */
const unpinned = new Map();
const UNPINNED_MS = 60_000;

/**
 * The pinned tool build a command must run instead of this entry, or null. Asking costs two Git processes, so a "no"
 * is remembered for a minute while the board's main commit and published selection stay the same.
 */
async function pinnedToolEntry(cwd) {
  let key = null;
  try {
    const location = gitLocation(cwd);
    if (location) {
      const main = headCommit({ gitDir: location.commonDir, commonDir: location.commonDir });
      let published = 'none';
      try { published = String(statSync(`${location.commonDir}/pullboard/tool-builds/current.json`).mtimeMs); } catch { /* None published. */ }
      key = `${location.commonDir}\0${main}\0${published}`;
    }
  } catch { key = null; }
  if (key && Date.now() - (unpinned.get(key) ?? -Infinity) < UNPINNED_MS) return null;
  const selected = await selectedToolEntry(cwd, entry);
  if (!selected && key) unpinned.set(key, Date.now());
  return selected;
}

/** A per-command output stream that frames text to the client and reports the client's terminal. */
function clientStream(store, frame, isTTY, columns) {
  return { isTTY, columns: columns ?? undefined, write(chunk, encoding, callback) {
    store.send(frame, chunk);
    if (typeof encoding === 'function') encoding(); else if (typeof callback === 'function') callback();
    return true;
  } };
}

/** Run one forwarded command and stream its output and exit code back. */
async function serve(socket, request) {
  const send = (value) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
  if (retired || request.code !== loadedCode || clock() - bornAt > MAX_AGE_MS) {
    retire(request.code !== loadedCode ? 'code' : 'age');
    return finish(socket, { t: 'stale' });
  }
  const store = { env: { ...request.env }, cwd: request.cwd,
    send: (frame, chunk) => send({ t: frame, d: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8') }) };
  inFlight.add(store);
  lastActive = clock();
  /** Run the command as the only one: its environment, directory and streams are the process's until it ends. */
  const run = async () => {
    running = store;
    try {
      if (!enterDirectory(store.cwd)) return null;
      // A pinned tool build runs its own entry, which the in-process path starts.
      try { if (await pinnedToolEntry(store.cwd)) return null; } catch { return null; }
      send({ t: 'start' });
      try {
        return await main(request.argv, { cwd: store.cwd, loadNativeBoard, loadProcessPorts, gateWaitReporter, stdin: process.stdin,
          stdout: clientStream(store, 'out', request.tty?.stdout === true, request.tty?.columns),
          stderr: clientStream(store, 'err', request.tty?.stderr === true, request.tty?.columns) });
      } catch (error) {
        store.send('err', `${error?.stack ?? String(error)}\n`);
        return 1;
      }
    } finally { running = null; }
  };
  let status;
  const turn = queue.then(run);
  queue = turn.catch(() => {});
  try { status = await turn; }
  finally {
    inFlight.delete(store);
    lastActive = clock();
  }
  finish(socket, status === null ? { t: 'fallback' } : { t: 'exit', code: status ?? 0 });
}

const server = createServer((socket) => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', function first(chunk) {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    socket.off('data', first);
    let request;
    try { request = JSON.parse(buffer.slice(0, newline)); } catch { return socket.destroy(); }
    // A tick asks for the idle check now, so a test drives retirement by its clock rather than by waiting.
    if (request.t === 'tick') {
      const idle = checkIdle({ exit: false });
      return finish(socket, { t: idle ? 'retired' : 'busy' });
    }
    void serve(socket, request);
  });
});

/** A command that throws outside its own promise ends every running command with that error, as one process would. */
function failed(error) {
  for (const store of inFlight) store.send('err', `${error?.stack ?? String(error)}\n`);
  release();
  process.exit(1);
}
process.on('uncaughtException', failed);
process.on('unhandledRejection', failed);

/** Listen at the board's socket path, unless a live resident process already does. */
function listen(retry = true) {
  server.once('error', (error) => {
    if (error.code !== 'EADDRINUSE' || !retry) {
      process.stderr.write(`pullboard resident: cannot listen at ${socketPath}: ${error.code ?? error.message}\n`);
      process.exit(0);
    }
    const probe = connect(socketPath);
    probe.on('connect', () => {
      probe.destroy();
      process.stderr.write(`pullboard resident: another resident process already listens at ${socketPath}\n`);
      process.exit(0);
    });
    probe.on('error', () => {
      // A live resident whose backlog is full refuses a connect; taking its path would orphan it with its queue.
      if (holderAlive()) {
        process.stderr.write(`pullboard resident: the resident process at ${socketPath} is alive but busy\n`);
        process.exit(0);
      }
      if (process.platform !== 'win32') try { unlinkSync(socketPath); } catch { /* Raced with another. */ }
      listen(false);
    });
  });
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') try { chmodSync(socketPath, 0o600); } catch { /* The board folder is already private to its owner. */ }
    ownSocket = socketIdentity();
    try { writeFileSync(pidFile, `${process.pid}\n`); } catch { /* The pid file only helps people and tests find it. */ }
    // Idle time counts from when the process can serve, never from a slow start under load.
    lastActive = clock();
    watchIdle();
    // A parent watching this process learns it serves from this line; a client-started one discards it.
    process.stdout.write('listening\n');
  });
}
listen();

/** Retire once nothing has run for the idle limit, or at once when a successor owns the socket path. */
function watchIdle() {
  setInterval(checkIdle, Math.min(IDLE_MS, REPLACED_CHECK_MS)).unref();
}

/** Retire when nothing has run for the idle limit or the socket path is another's; true when this check retired it. */
function checkIdle({ exit = true } = {}) {
  if (!retired && replaced()) {
    retire('replaced');
    if (exit) exitWhenDone();
    return true;
  }
  if (retired) { if (exit) exitWhenDone(); return false; }
  if (inFlight.size || clock() - lastActive <= IDLE_MS) return false;
  retire('idle');
  if (exit) exitWhenDone();
  return true;
}

// Load each served command's modules now, so the first command after a start is warm too.
void (async () => {
  const { COMMANDS } = await import('../apps/cli/src/shell/commands/index.js');
  const { RESIDENT_COMMANDS } = await import('./resident-client.js');
  await loadNativeBoard();
  await loadProcessPorts();
  for (const name of RESIDENT_COMMANDS) await COMMANDS[name]?.().catch(() => {});
  lastActive = Math.max(lastActive, clock());
})().catch(() => {});
