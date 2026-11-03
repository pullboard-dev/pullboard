#!/usr/bin/env node
/**
 * The resident board process: one per board checkout and CLI entry, started by the thin client on first use. It keeps
 * the CLI's modules loaded and the board open, holding read-only connections that read commands reuse, and runs each
 * forwarded command through src/cli-main.js, the same entry the in-process path uses, so a warm command pays only for
 * its own work [H24,C7].
 *
 * Commands may run concurrently, so each one's state stays its own: process.env reads and writes go to that command's
 * environment, the real working directory follows the command whose code is running (child processes and relative
 * paths resolve there), and its stdout and stderr, including direct process.stdout writes, stream to its client only.
 * Each command owns the connection it takes until it closes the board. It retires, closing every connection, when its
 * code is no longer the entry's code, after an hour, and when idle.
 */
import {
  AsyncLocalStorage,
  createHook,
} from 'node:async_hooks';
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

// Node 22 announces that node:sqlite is experimental; the in-process entry drops that notice, and so does this one.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

const [socketPath, entry, loadedCode, pidFile] = process.argv.slice(2);
const IDLE_MS = Number(process.env.PULLBOARD_RESIDENT_IDLE_MS) || 15 * 60_000;
const MAX_AGE_MS = Number(process.env.PULLBOARD_RESIDENT_MAX_AGE_MS) || 60 * 60_000;
const bornAt = Date.now();
const commands = new AsyncLocalStorage();
const baseEnv = process.env;
const inFlight = new Set();
let lastActive = Date.now();
let retired = false;

/** The environment of the command whose code is running, or the process's own between commands. */
const activeEnv = () => commands.getStore()?.env ?? baseEnv;
process.env = new Proxy({}, {
  get: (_, key) => typeof key === 'string' ? activeEnv()[key] : undefined,
  set: (_, key, value) => { if (typeof key === 'string') activeEnv()[key] = String(value); return true; },
  deleteProperty: (_, key) => { delete activeEnv()[key]; return true; },
  has: (_, key) => key in activeEnv(),
  ownKeys: () => Reflect.ownKeys(activeEnv()),
  getOwnPropertyDescriptor: (_, key) => Object.hasOwn(activeEnv(), key)
    ? { value: activeEnv()[key], writable: true, enumerable: true, configurable: true } : undefined,
});

let directory = process.cwd();
/** Make the real working directory the running command's own before any of its callbacks runs. */
function enterDirectory(cwd) {
  if (cwd === directory) return;
  try { process.chdir(cwd); directory = cwd; } catch { /* A removed directory keeps the previous one. */ }
}
createHook({ before() { const store = commands.getStore(); if (store) enterDirectory(store.cwd); } }).enable();

for (const [name, frame] of [['stdout', 'out'], ['stderr', 'err']]) {
  const stream = process[name];
  const write = stream.write.bind(stream);
  /** Route a direct process stream write to the command that made it; between commands it goes nowhere visible. */
  stream.write = (chunk, encoding, callback) => {
    const store = commands.getStore();
    if (!store) return write(chunk, encoding, callback);
    store.send(frame, chunk);
    if (typeof encoding === 'function') encoding(); else if (typeof callback === 'function') callback();
    return true;
  };
}

/** Remove the socket and pid file this process made, leaving a successor's in place. */
function release() {
  try { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile); } catch { /* Already gone. */ }
  if (process.platform !== 'win32') try { unlinkSync(socketPath); } catch { /* Already gone. */ }
}

/** Stop taking commands and free the socket path for a successor now; exitWhenDone ends the process. */
function retire(reason) {
  if (retired) return;
  retired = true;
  trace(`retire:${reason}`, null);
  release();
  server.close();
  closeConnections();
}

/** Exit a retired process once its running commands have finished. */
function exitWhenDone() {
  if (retired && !inFlight.size) process.exit(0);
}

const { main, selectedToolEntry } = await import('../src/cli-main.js');
const { loadNativeBoard, loadProcessPorts } = await import('./process-ports.js');
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
  for (const idle of connections.values()) for (const entry of idle) closeConnection(entry);
  connections.clear();
}

// Every read open in this process, whichever module asks, takes a connection the process holds.
holdReadConnections(takeConnection);

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
  if (retired || request.code !== loadedCode || Date.now() - bornAt > MAX_AGE_MS) {
    retire(request.code !== loadedCode ? 'code' : 'age');
    return socket.end(JSON.stringify({ t: 'stale' }) + '\n', exitWhenDone);
  }
  const store = { env: { ...request.env }, cwd: request.cwd,
    send: (frame, chunk) => send({ t: frame, d: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8') }) };
  inFlight.add(store);
  lastActive = Date.now();
  let status;
  try {
    status = await commands.run(store, async () => {
      enterDirectory(store.cwd);
      if (directory !== store.cwd) return null;
      // A pinned tool build runs its own entry, which the in-process path starts.
      try { if (await selectedToolEntry(store.cwd, entry)) return null; } catch { return null; }
      send({ t: 'start' });
      try {
        return await main(request.argv, { cwd: store.cwd, loadNativeBoard, loadProcessPorts, stdin: process.stdin,
          stdout: clientStream(store, 'out', request.tty?.stdout === true, request.tty?.columns),
          stderr: clientStream(store, 'err', request.tty?.stderr === true, request.tty?.columns) });
      } catch (error) {
        store.send('err', `${error?.stack ?? String(error)}\n`);
        return 1;
      }
    });
  } finally {
    inFlight.delete(store);
    lastActive = Date.now();
  }
  socket.end(JSON.stringify(status === null ? { t: 'fallback' } : { t: 'exit', code: status ?? 0 }) + '\n', exitWhenDone);
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
    if (error.code !== 'EADDRINUSE' || !retry) process.exit(0);
    const probe = connect(socketPath);
    probe.on('connect', () => { probe.destroy(); process.exit(0); });
    probe.on('error', () => {
      if (process.platform !== 'win32') try { unlinkSync(socketPath); } catch { /* Raced with another. */ }
      listen(false);
    });
  });
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') try { chmodSync(socketPath, 0o600); } catch { /* The board folder is already private to its owner. */ }
    try { writeFileSync(pidFile, `${process.pid}\n`); } catch { /* The pid file only helps people and tests find it. */ }
    // Idle time counts from when the process can serve, never from a slow start under load.
    lastActive = Date.now();
    watchIdle();
  });
}
listen();

/** Retire once nothing has run for the idle limit; the watch starts only when the process is listening. */
function watchIdle() {
  setInterval(() => {
    if (!inFlight.size && Date.now() - lastActive > IDLE_MS) { retire('idle'); exitWhenDone(); }
  }, Math.min(IDLE_MS, 30_000)).unref();
}

// Load each served command's modules now, so the first command after a start is warm too.
void (async () => {
  const { COMMANDS } = await import('../src/commands/index.js');
  const { RESIDENT_COMMANDS } = await import('./resident-client.js');
  await loadNativeBoard();
  await loadProcessPorts();
  for (const name of RESIDENT_COMMANDS) await COMMANDS[name]?.().catch(() => {});
  lastActive = Math.max(lastActive, Date.now());
})().catch(() => {});
