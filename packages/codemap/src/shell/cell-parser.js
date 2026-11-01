/** Share one compile-only V8 process across a cell-lint command's bounded batches [C7,P3]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const parsers = new AsyncLocalStorage();
const MAX_BYTES = 2 ** 26;

/** Refuse transport failures without exposing candidate source or treating them as syntax failures. */
function failure() { return new Error('cell binding compiler setup failed: invalid or missing V8 parser reply'); }

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
export function withCellLintParser(work) {
  if (parsers.getStore()) return work(parsers.getStore());
  let child = null, directory = null, sequence = 0, failed = false;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  /** Close only this command's child and private transport on completion, failure or parent exit. */
  function close() {
    if (child) { child.kill('SIGKILL'); child.unref(); child = null; }
    if (directory) { rmSync(directory, { recursive: true, force: true }); directory = null; }
  }
  /** Compile the next bounded batch without linking, evaluating or retaining repository modules. */
  function parseBatch(sources) {
    if (failed || !Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw failure();
    const id = ++sequence;
    const input = JSON.stringify({ version: 1, id, sources });
    if (Buffer.byteLength(input) > MAX_BYTES) throw failure();
    if (!child) {
      directory = mkdtempSync(join(tmpdir(), 'pullboard-cell-parser-'));
      child = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
        fileURLToPath(new URL('./cell-parser-worker.js', import.meta.url)), directory, String(process.pid)],
      { stdio: 'ignore' });
      child.on('error', () => { failed = true; });
      child.unref();
      if (!Number.isSafeInteger(child.pid)) throw failure();
    }
    const request = join(directory, `request-${id}.json`), reply = join(directory, `reply-${id}.json`);
    const temporary = request + '.tmp';
    const deadline = process.hrtime.bigint() + 10_000_000_000n;
    try {
      writeFileSync(temporary, input, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, request);
      while (process.hrtime.bigint() < deadline) {
        const results = replyAt(reply, id, sources.length);
        if (results) return results;
        // Budget: only this private reply is checked, every 2ms within the existing ten-second batch limit.
        Atomics.wait(sleeper, 0, 0, 2);
      }
      throw failure();
    } catch (error) { failed = true; throw error; }
    finally { rmSync(request, { force: true }); rmSync(reply, { force: true }); }
  }
  /** Keep the import scanner's expanded variants in bounded requests without changing result order. */
  function parse(sources) {
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw failure();
    let chunk = [], bytes = 0;
    const results = [];
    for (const source of sources) {
      const size = Buffer.byteLength(JSON.stringify(source)) + 1;
      if (chunk.length && bytes + size > 8 * 1024 * 1024) {
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
