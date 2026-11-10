/** Share one compile-only V8 process across a cell-lint command's bounded batches [C7,P3]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadavg } from 'node:os';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const parsers = new AsyncLocalStorage();
const MAX_BYTES = 2 ** 26;

/** Refuse transport failures without exposing candidate source or treating them as syntax failures. */
function failure() { return new Error('cell binding compiler setup failed: invalid or missing V8 parser reply'); }

/** Retain bounded real stderr without loading a potentially large crash log into the caller. */
function compilerStderr(directory) {
  let fd;
  try {
    const file = join(directory, 'stderr.log'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    fd = openSync(file, 'r');
    const head = Buffer.alloc(Math.min(stat.size, 2048));
    readSync(fd, head, 0, head.length, 0);
    if (stat.size <= head.length) return head.toString('utf8').trim();
    const tail = Buffer.alloc(Math.min(stat.size - head.length, 2048));
    readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    return `${head.toString('utf8')}\n…\n${tail.toString('utf8')}`.trim();
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A supervisor's atomically published exit is a failure even if the compiler exited zero without a reply. */
function compilerExit(directory) {
  let stat;
  const file = join(directory, 'exit.json');
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw failure();
  const exit = JSON.parse(readFileSync(file, 'utf8'));
  if (exit?.version !== 1 || !(exit.code === null || Number.isInteger(exit.code))
    || !(exit.signal === null || typeof exit.signal === 'string')) throw failure();
  const stderr = compilerStderr(directory);
  return Object.assign(new Error(`cell binding compiler exited ${exit.code ?? 'none'}, signal ${exit.signal ?? 'none'}${exit.error ? `: ${exit.error}` : ''}${stderr ? `; stderr: ${stderr}` : ''}`),
    { code: 'CELL_BINDING_WORKER_EXIT', workerExitCode: exit.code, workerSignal: exit.signal, stderr });
}

/** A clean supervisor rotation witnesses that its last compiler has closed. */
function supervisorRotation(directory, pid) {
  const file = join(directory, 'supervisor-rotation.json');
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw failure();
  const rotation = JSON.parse(readFileSync(file, 'utf8'));
  if (rotation?.version !== 1 || rotation.pid !== pid || !Number.isSafeInteger(rotation.sequence) || rotation.sequence < 1) throw failure();
  return rotation;
}

/** Read an atomically published, bounded ordinary reply; absence means this batch is still compiling. */
function replyAt(file, id, count) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw failure();
  const reply = JSON.parse(readFileSync(file, 'utf8'));
  if (reply?.version !== 1 || reply.id !== id || !Array.isArray(reply.results) || reply.results.length !== count
    || reply.results.some(row => typeof row?.compiles !== 'boolean' || !Array.isArray(row.imports)
      || row.imports.some(value => typeof value !== 'string') || !row.compiles && row.imports.length)) throw failure();
  return reply.results;
}

/** Run synchronous cell analysis with one lazy, owned parser; cached checks need no process at all. */
export function withCellLintParser(work, { directory: cacheDirectory } = {}) {
  if (parsers.getStore()) return work(parsers.getStore());
  let child = null, directory = null, sequence = 0, failed = null, closed = false;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  /** Close only this command's child and private transport on completion, failure or parent exit. */
  function close() {
    closed = true;
    if (child) {
      let rotation = null;
      try { rotation = supervisorRotation(directory, child.pid); } catch { /* Invalid evidence cannot prove cleanup. */ }
      if (!rotation) child.kill('SIGTERM');
      // budget: five seconds to observe the owned supervisor's terminal journal before removing its transport.
      const deadline = process.hrtime.bigint() + 5_000_000_000n;
      let terminal = !Number.isSafeInteger(child.pid) || Boolean(rotation);
      while (Number.isSafeInteger(child.pid) && process.hrtime.bigint() < deadline) {
        if (terminal) break;
        try { terminal = Boolean(supervisorRotation(directory, child.pid)); } catch { /* A malformed record is not a terminal witness. */ }
        if (terminal) break;
        try { terminal = Boolean(compilerExit(directory)); } catch { /* A malformed record is not a terminal witness. */ }
        if (terminal) break;
        Atomics.wait(sleeper, 0, 0, 2);
      }
      child.unref();
      child = null;
      if (!terminal) {
        const message = `cell binding compiler cleanup is unconfirmed; retained transport ${directory}`;
        if (failed) { failed.cleanupError = message; failed.message += `; ${message}`; return; }
        throw new Error(message);
      }
    }
    if (directory) { rmSync(directory, { recursive: true, force: true }); directory = null; }
  }
  /** Start an owned supervisor at the last completed sequence, never before a rotation witness. */
  function startSupervisor(previous) {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning',
      fileURLToPath(new URL('./parser/worker.js', import.meta.url)), directory, String(process.pid), '--supervise', String(previous)],
    { stdio: 'ignore' });
    child.on('error', error => { failed ??= error; });
    child.unref();
    if (!Number.isSafeInteger(child.pid)) throw failure();
  }
  /** Move to a new supervisor only after its predecessor recorded the exact completed request. */
  function rotateSupervisor(expected) {
    const rotation = supervisorRotation(directory, child.pid);
    if (!rotation) return false;
    if (rotation.sequence !== expected) throw failure();
    child.unref();
    child = null;
    rmSync(join(directory, 'supervisor-rotation.json'));
    startSupervisor(expected);
    return true;
  }
  /** Compile the next bounded batch without linking, evaluating or retaining repository modules. */
  function parseBatch(sources) {
    if (failed) throw failed;
    if (closed || !Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw failure();
    const id = ++sequence;
    const input = JSON.stringify({ version: 1, id, sources });
    if (Buffer.byteLength(input) > MAX_BYTES) throw failure();
    if (!child) {
      if (cacheDirectory) mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
      directory = mkdtempSync(join(cacheDirectory ?? tmpdir(), 'pullboard-cell-parser-'));
      startSupervisor(id - 1);
    }
    const request = join(directory, `request-${id}.json`), reply = join(directory, `reply-${id}.json`);
    const temporary = request + '.tmp';
    const load = loadavg()[0], cores = availableParallelism();
    const extension = Math.min(120_000, Math.max(30_000, Math.ceil(10_000 * (1 + load / cores))));
    const deadline = process.hrtime.bigint() + BigInt(10_000 + extension) * 1_000_000n;
    try {
      writeFileSync(temporary, input, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, request);
      while (process.hrtime.bigint() < deadline) {
        const results = replyAt(reply, id, sources.length);
        if (results) return results;
        if (rotateSupervisor(id - 1)) continue;
        const exited = compilerExit(directory);
        if (exited) throw exited;
        // Budget: poll only this private reply; the bounded extension accommodates a loaded machine.
        Atomics.wait(sleeper, 0, 0, 2);
      }
      throw Object.assign(new Error(`cell binding compiler timeout after extended batch wait (${10_000 + extension} ms; load ${load.toFixed(2)}, ${cores} cores)`), { code: 'CELL_BINDING_TIMEOUT' });
    } catch (error) { failed = error; throw error; }
    finally { rmSync(request, { force: true }); rmSync(reply, { force: true }); }
  }
  /** Keep the import scanner's expanded variants in bounded requests without changing result order. */
  function parse(sources) {
    if (closed || !Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw failure();
    let chunk = [], bytes = 0;
    const results = [];
    for (const source of sources) {
      const size = Buffer.byteLength(JSON.stringify(source)) + 1;
      if (chunk.length && (chunk.length >= 128 || bytes + size > 8 * 1024 * 1024)) {
        results.push(...parseBatch(chunk)); chunk = []; bytes = 0;
      }
      chunk.push(source); bytes += size;
    }
    if (chunk.length) results.push(...parseBatch(chunk));
    return results;
  }
  process.once('exit', close);
  try { return parsers.run(parse, () => work(parse)); }
  finally { process.removeListener('exit', close); close(); }
}

/** Binding analysis uses the same actual compiler as import analysis inside a lint command. */
export function currentCellLintParser() { return parsers.getStore(); }
