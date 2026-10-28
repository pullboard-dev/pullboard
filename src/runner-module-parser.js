/** One private compile-only VM child per derived runner closure [C7,P3]. */
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from './refused.js';

const MAX_BYTES = 2 ** 26;
const TIMEOUT_MS = 10_000;
const PARSER_PATH = fileURLToPath(import.meta.url);
const WORKER_PATH = fileURLToPath(new URL('./runner-module-parser-worker.js', import.meta.url));
const LOADED_COMPILER = captureCompiler();

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
  const compiled = new Map();
  let compiledBytes = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  /** Retain only bounded exact-source compiler results within this one private derive. */
  function remember(source, result) {
    const bytes = Buffer.byteLength(source) + Buffer.byteLength(JSON.stringify(result));
    // Budget: memoization retains at most 4 MiB/4096 entries; oversized misses still compile normally.
    if (compiled.size >= 4096 || compiledBytes + bytes > 4 * 1024 ** 2) return;
    compiled.set(source, Object.freeze({ compiles: result.compiles, imports: Object.freeze([...result.imports]) }));
    compiledBytes += bytes;
  }

  /** Rebuild the caller's original order with independent rows and import arrays, including duplicates. */
  function orderedResults(sources, fresh) {
    return sources.map(source => {
      const result = compiled.get(source) ?? fresh.get(source);
      return { compiles: result.compiles, imports: [...result.imports] };
    });
  }

  /** Request termination only of this factory's child and remove only its private protocol directory. */
  function close() {
    if (closed) return;
    closed = true;
    compiled.clear();
    compiledBytes = 0;
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

  /** Start the trusted parser entry without inherited Node flags, stdin, pipes or repository evaluation. */
  function start() {
    if (child) return;
    directory = mkdtempSync(join(tmpdir(), 'pullboard-runner-parser-'));
    child = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
      WORKER_PATH, directory, String(process.pid)],
    { stdio: 'ignore' });
    // This prevents an unhandled late error; synchronous progress depends only on the bounded reply protocol.
    child.on('error', () => { childFailed = true; });
    if (!Number.isSafeInteger(child.pid)) throw parserFailure();
  }

  /** Compile source text only, waiting on one atomic regular-file reply under the existing parser deadline. */
  function parse(sources) {
    let request = null;
    let reply = null;
    try {
      assertRunnerModuleParserCurrent();
      if (closed || childFailed || !Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw parserFailure();
      const missing = [...new Set(sources.filter(source => !compiled.has(source)))];
      if (!missing.length) return orderedResults(sources, new Map());
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
      while (true) {
        if (process.hrtime.bigint() >= deadline) throw parserFailure();
        const result = replyAt(reply);
        if (result !== undefined) {
          const rows = checkedResults(result, id, missing.length);
          assertRunnerModuleParserCurrent();
          const fresh = new Map(missing.map((source, index) => [source, rows[index]]));
          for (const [source, row] of fresh) remember(source, row);
          return orderedResults(sources, fresh);
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
