/** One private compile-only VM child per derived runner closure [C7,P3]. */
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../../kernel/index.js';

const MAX_BYTES = 2 ** 26;
const TIMEOUT_MS = 10_000;
const PARSER_PATH = fileURLToPath(import.meta.url);
const WORKER_PATH = fileURLToPath(new URL('./parser/worker.js', import.meta.url));
const LOADED_COMPILER = captureCompiler();
// Process-lifetime cache keyed by the content hash of each source; compile results depend only on source bytes.
// Budget: at most 4 MiB/4096 entries for the life of the process; oversized misses still compile normally.
const PROCESS_CACHE = new Map();
let processCacheBytes = 0;
let sourcesCompiled = 0;

/** Count of sources sent to a compiler child in this process, so callers can prove a cache hit parsed nothing. */
export function runnerModuleParserCompileCount() {
  return sourcesCompiled;
}

/** Path plus content hash that keys the process cache, so a changed file is a different entry and is re-parsed. */
function sourceKey(source, path = '') {
  return `${path}\0${createHash('sha256').update(source).digest('hex')}`;
}

/**
 * Bind a parser's `parse` to the files whose sources a caller passes first, so the process cache key is the
 * real path plus content hash. The probe variants an import scan appends after those sources key on the whole
 * path set, so they never fall back to the empty path; correctness still rests on the content hash.
 *
 * @param {(sources: string[], paths?: string[]) => Array<{compiles: boolean, imports: string[]}>} parse
 * @param {string[]} files - One path per leading source, in order.
 * @returns {(sources: string[]) => Array<{compiles: boolean, imports: string[]}>}
 */
export function parseWithPaths(parse, files) {
  const variantPath = `${files.join('\n')}#probe`;
  return sources => parse(sources, sources.map((_source, index) => files[index] ?? variantPath));
}

/** Read exact owned compiler bytes; a symlink or unbounded entry cannot become a trusted parser. */
function compilerBytes(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw parserFailure();
  return readFileSync(file);
}

/** Retain initial failure as an unusable generation rather than allowing a partially pinned compiler. */
function captureCompiler() {
  try { return { parser: compilerBytes(PARSER_PATH), worker: compilerBytes(WORKER_PATH) }; }
  catch { return null; }
}

/** Guard this new controller-only pair independently of the worker capsule's derived dependency graph. */
export function assertRunnerModuleParserCurrent() {
  try {
    if (!LOADED_COMPILER || !compilerBytes(PARSER_PATH).equals(LOADED_COMPILER.parser)
      || !compilerBytes(WORKER_PATH).equals(LOADED_COMPILER.worker)) throw parserFailure();
  } catch {
    throw new Refused('RUNNER_TOOLING_CHANGED', 'the private runner compiler changed since this controller loaded; restart the command from the current committed CLI before retrying');
  }
}

/** Reject malformed protocol output without displaying source bytes or child diagnostics. */
function parserFailure() {
  return new Error('V8 import parser failed: private compiler did not return a valid bounded reply');
}

/** Return a bounded regular-file reply, or undefined while this exact owned reply is not present. */
function replyAt(file) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw parserFailure(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw parserFailure();
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw parserFailure(); }
}

/** Validate the complete compiler result before any import edge can enter a trusted closure. */
function checkedResults(reply, id, count) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || Object.keys(reply).sort().join(',') !== 'id,results,version'
    || reply.version !== 1 || reply.id !== id || !Array.isArray(reply.results)
    || reply.results.length !== count) throw parserFailure();
  return reply.results.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'compiles,imports'
      || typeof row.compiles !== 'boolean' || !Array.isArray(row.imports)
      || row.imports.some(value => typeof value !== 'string')
      || !row.compiles && row.imports.length) throw parserFailure();
    return { compiles: row.compiles, imports: [...row.imports] };
  });
}

/** Create a lazy synchronous parser; close requests owned-child termination, not an observed-exit receipt. */
export function createRunnerModuleParser() {
  let child = null;
  let directory = null;
  let closed = false;
  let childFailed = false;
  let sequence = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  /** Retain bounded compiler results for the life of the process, keyed by source content hash. */
  function remember(source, result, path) {
    const bytes = Buffer.byteLength(source) + Buffer.byteLength(JSON.stringify(result));
    // Budget: memoization retains at most 4 MiB/4096 entries; oversized misses still compile normally.
    const key = sourceKey(source, path);
    if (PROCESS_CACHE.has(key) || PROCESS_CACHE.size >= 4096 || processCacheBytes + bytes > 4 * 1024 ** 2) return;
    PROCESS_CACHE.set(key, Object.freeze({ compiles: result.compiles, imports: Object.freeze([...result.imports]) }));
    processCacheBytes += bytes;
  }

  /** Rebuild the caller's original order with independent rows and import arrays, including duplicates. */
  function orderedResults(sources, fresh, paths) {
    return sources.map((source, index) => {
      const result = PROCESS_CACHE.get(sourceKey(source, paths[index])) ?? fresh.get(source);
      return { compiles: result.compiles, imports: [...result.imports] };
    });
  }

  /** Request termination only of this factory's child and remove only its private protocol directory. */
  function close() {
    if (closed) return;
    closed = true;
    let failed = false;
    if (child) {
      try { child.kill('SIGKILL'); }
      catch { failed = true; }
      finally { child.unref(); }
    }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); }
    catch { failed = true; }
    if (failed) throw parserFailure();
  }

  /** Start the trusted parser entry without source input or repository evaluation. */
  function start() {
    if (child) return;
    directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-parser-'));
    // Execute the module-load snapshot, never a path that can change after its freshness check.
    const worker = join(directory, 'compiler-worker.mjs');
    writeFileSync(worker, LOADED_COMPILER.worker, { mode: 0o400, flag: 'wx' });
    child = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
      worker, directory, String(process.pid)],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.channel?.unref();
    // This prevents an unhandled late error; synchronous progress depends only on the bounded reply protocol.
    child.on('error', () => { childFailed = true; });
    if (!Number.isSafeInteger(child.pid)) throw parserFailure();
  }

  /** Compile source text only (optional `paths` pair each source with its file for the cache key), waiting on one atomic regular-file reply under the existing parser deadline. */
  function parse(sources, paths = []) {
    let request = null;
    let reply = null;
    try {
      assertRunnerModuleParserCurrent();
      if (closed || childFailed || !Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw parserFailure();
      if (!Array.isArray(paths) || paths.some(path => path !== undefined && typeof path !== 'string')) throw parserFailure();
      const missing = [...new Set(sources.filter((source, index) => !PROCESS_CACHE.has(sourceKey(source, paths[index]))))];
      if (!missing.length) return orderedResults(sources, new Map(), paths);
      sourcesCompiled += missing.length;
      const id = ++sequence;
      if (!Number.isSafeInteger(id)) throw parserFailure();
      const input = JSON.stringify({ version: 1, id, sources: missing });
      const deadline = process.hrtime.bigint() + BigInt(TIMEOUT_MS) * 1_000_000n;
      start();
      request = join(directory, `request-${id}.json`);
      reply = join(directory, `reply-${id}.json`);
      const temporary = join(directory, `request-${id}.tmp`);
      writeFileSync(temporary, input, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, request);
      // Wake only: source and results remain in the validated atomic-file protocol.
      child.send(id);
      while (true) {
        if (process.hrtime.bigint() >= deadline) throw parserFailure();
        const result = replyAt(reply);
        if (result !== undefined) {
          const rows = checkedResults(result, id, missing.length);
          assertRunnerModuleParserCurrent();
          const fresh = new Map(missing.map((source, index) => [source, rows[index]]));
          sources.forEach((source, index) => { if (fresh.has(source)) remember(source, fresh.get(source), paths[index]); });
          return orderedResults(sources, fresh, paths);
        }
        const remaining = Number(deadline - process.hrtime.bigint()) / 1e6;
        if (remaining <= 0) throw parserFailure();
        // Budget: poll only this owned reply every at most 2ms, for the existing 10-second parser limit.
        Atomics.wait(sleeper, 0, 0, Math.min(2, remaining));
      }
    } catch (error) {
      close();
      if (error instanceof Refused) throw error;
      throw parserFailure();
    } finally {
      if (!closed) {
        try {
          if (request) rmSync(request, { force: true });
          if (reply) rmSync(reply, { force: true });
        } catch {
          close();
          throw parserFailure();
        }
      }
    }
  }

  return { parse, close };
}
