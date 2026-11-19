/** Child-process fixture helpers for the git cell: a private fixture root, a redacting child runner and a git runner [C7]. */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  sep,
} from 'node:path';
import { tmpdir } from 'node:os';

/** Own a newly created private fixture root and read only files this capability actually created. */
export function privateFixtureFiles(prefix = 'pullboard-fixture-input-') {
  if (typeof prefix !== 'string' || !/^[a-z0-9-]+$/u.test(prefix)) throw new Error('invalid private fixture prefix');
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const owned = new Set();
  /** Resolve an explicit relative file without traversing symbolic or non-directory ancestors. */
  function pathFor(file, create = false) {
    if (typeof file !== 'string' || !file || /[\\:\x00-\x1f\x7f]/u.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid private fixture file');
    let directory = root;
    for (const part of file.split('/').slice(0, -1)) {
      directory = join(directory, part);
      let stat;
      try { stat = lstatSync(directory); }
      catch (error) { if (!create || error.code !== 'ENOENT') throw error; mkdirSync(directory); stat = lstatSync(directory); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private fixture ancestor is not a directory');
    }
    const path = join(root, file);
    if (!realpathSync(directory).startsWith(root + sep) && directory !== root) throw new Error('private fixture escaped its root');
    return path;
  }
  /** Write and register the real private input; an existing unowned or symbolic file never acquires authority. */
  function write(file, bytes) {
    const path = pathFor(file, true);
    try {
      const stat = lstatSync(path);
      if (!owned.has(file) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('private fixture file is not owned');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeFileSync(path, bytes);
    owned.add(file);
  }
  /** Preserve exact current working bytes, including changes made by the actual component under test. */
  function read(file) {
    if (!owned.has(file)) throw new Error('private fixture file is not owned');
    const path = pathFor(file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('private fixture file is not regular');
    return readFileSync(path);
  }
  return Object.freeze({ root, write, read });
}

const SENSITIVE_NAME = /(?:token|secret|password|private.?key|access.?key|relay[_ -]?key|pairing.?code|verification.?code)/iu;
/** Redact known fixture credentials before a child failure reaches an assertion message. */
export function safeFixtureDiagnostic(value, env = process.env) {
  let text = String(value ?? '');
  for (const [name, secret] of Object.entries(env ?? {})) {
    if (SENSITIVE_NAME.test(name) && typeof secret === 'string' && secret.length >= 4) {
      text = text.replaceAll(secret, '[redacted]');
    }
  }
  return text
    .replace(/\b(?:ps|pa|pm|pg)_[A-Za-z0-9_-]+\b/gu, '[redacted-token]')
    .replace(/\b[a-f\d]{32}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/giu, '[redacted-pairing-code]')
    .replace(/((?:token|secret|password|private[_ -]?key|access[_ -]?key|relay[_ -]?key|pairing[_ -]?code|verification[_ -]?code)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, '$1[redacted]');
}

/** Format one failed fixture child without leaking fixture credentials. */
export function fixtureChildFailureContext({ command, args = [], status, signal, elapsedMs, stderr = '', env = process.env, detail = '' }) {
  return [
    `command: ${safeFixtureDiagnostic(JSON.stringify([command, ...args]), env)}`,
    `status: ${status === null ? 'null' : status}`,
    `signal: ${signal ?? 'none'}`,
    `elapsed: ${Math.round(elapsedMs)}ms`,
    `stderr: ${safeFixtureDiagnostic(stderr, env)}`,
    ...(detail ? [`detail: ${safeFixtureDiagnostic(detail, env)}`] : []),
  ].join('\n');
}

/** Emit and return the common diagnostic for any unexpected fixture child result. */
export function reportFixtureChildFailure(options) {
  const context = fixtureChildFailureContext(options);
  process.stderr.write(`${context}\n`);
  return context;
}

/** Run one fixture child and retain enough context to explain any failed result. */
export function runFixtureChild(command, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const started = performance.now();
  const stderrIgnored = options.stdio === 'ignore' || (Array.isArray(options.stdio) && options.stdio[2] === 'ignore');
  const childOptions = stderrIgnored ? { ...options, stdio: options.stdio === 'ignore'
    ? ['ignore', 'ignore', 'pipe'] : [options.stdio[0], options.stdio[1], 'pipe'] } : options;
  const result = spawnSync(command, args, childOptions);
  const elapsedMs = Math.round(performance.now() - started);
  const env = options.env ?? process.env;
  const stderr = safeFixtureDiagnostic(Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : (result.stderr ?? ''), env);
  const safeCommand = safeFixtureDiagnostic(JSON.stringify([command, ...args]), env);
  const context = [
    `command: ${safeCommand}`,
    `status: ${result.status === null ? 'null' : result.status}`,
    `signal: ${result.signal ?? 'none'}`,
    `elapsed: ${elapsedMs}ms`,
    `stderr: ${stderr}`,
  ].join('\n');
  // A --json command prints its refusal on stdout and nothing on stderr, so a failed child also shows the start of its stdout.
  const stdoutText = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : (result.stdout ?? '');
  const detail = [result.error?.message ?? '', result.status !== 0 && stdoutText ? `stdout: ${stdoutText.slice(0, 2000)}` : ''].filter(Boolean).join('\n');
  const failure = result.status === 0 && !result.signal && !result.error ? null : reportFixtureChildFailure({
    command, args, status: result.status, signal: result.signal, elapsedMs, stderr, env,
    detail,
  });
  return { ...result, stderr: stderrIgnored ? null : result.stderr, command: [command, ...args], elapsedMs, context: detail ? `${context}\n${safeFixtureDiagnostic(detail, env)}` : context, failure };
}

/** Run a successful Git fixture operation and include elapsed command context if it fails. */
export function runFixtureGit(args, options = {}) {
  const result = runFixtureChild('git', args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(result.failure);
  return result.stdout.trim();
}

/** The model name fixture seats join with when a test passes `--model` itself. */
export const FIXTURE_MODEL = 'Fixture Model';
