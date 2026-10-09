/** Shared private fixture child runner and redacted failure diagnostics [C7]. */
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const SENSITIVE_NAME = /(?:token|secret|password|private.?key|access.?key|relay[_ -]?key|pairing.?code|verification.?code)/iu;
const activeFixtureChildren = new Set();

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
  const failure = result.status === 0 && !result.signal && !result.error ? null : reportFixtureChildFailure({
    command, args, status: result.status, signal: result.signal, elapsedMs, stderr, env,
    detail: result.error?.message ?? '',
  });
  return { ...result, stderr: stderrIgnored ? null : result.stderr, command: [command, ...args], elapsedMs, context, failure };
}

/** Run an async fixture child, retaining redacted diagnostics without imposing a child clock. */
export function runFixtureChildAsync(command, args, options = {}) {
  const { onStderrChunk, ...spawnOptions } = options;
  const started = performance.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
  activeFixtureChildren.add(child);
  let stdout = '';
  let rawStderr = '';
  return new Promise((resolveResult) => {
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => {
      rawStderr += part;
      onStderrChunk?.(part, child);
    });
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (status, signal) => {
      activeFixtureChildren.delete(child);
      const elapsedMs = Math.round(performance.now() - started);
      const env = spawnOptions.env ?? process.env;
      const stderr = safeFixtureDiagnostic(rawStderr, env);
      const safeCommand = safeFixtureDiagnostic(JSON.stringify([command, ...args]), env);
      const context = [
        `command: ${safeCommand}`,
        `status: ${status === null ? 'null' : status}`,
        `signal: ${signal ?? 'none'}`,
        `elapsed: ${elapsedMs}ms`,
        `stderr: ${stderr}`,
        ...(spawnError ? [`spawn error: ${safeFixtureDiagnostic(spawnError.message, env)}`] : []),
      ].join('\n');
      const failure = status === 0 && !signal && !spawnError ? null : reportFixtureChildFailure({
        command, args, status, signal, elapsedMs, stderr, env,
        detail: spawnError?.message ?? '',
      });
      resolveResult({ status, signal, stdout, stderr, elapsedMs, context, failure, error: spawnError });
    });
  });
}

/** Stop only fixture children still alive when their owning test file has finished. */
export async function cleanupFixtureChildren() {
  const children = [...activeFixtureChildren];
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map((child) => new Promise((resolveClosed) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveClosed();
    child.once('close', resolveClosed);
  })));
}

/** Prefer the structured child context in a failed assertion while keeping raw stderr untouched. */
export function fixtureChildMessage(result) {
  return result.failure ?? result.stderr ?? '';
}

/** Run a successful Git fixture operation and include elapsed command context if it fails. */
export function runFixtureGit(args, options = {}) {
  const result = runFixtureChild('git', args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(result.failure);
  return result.stdout.trim();
}

/** Preserve execFileSync output and failure fields while adding common child diagnostics. */
export function runFixtureExecFile(command, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const result = runFixtureChild(command, args, options);
  if (result.failure) {
    const error = new Error(result.failure);
    Object.assign(error, result);
    throw error;
  }
  return result.stdout;
}

/** Execute a fixture shell command with the same output contract and failure evidence. */
export function runFixtureExec(command, options = {}) {
  return runFixtureExecFile(options.shell ?? '/bin/sh', ['-c', command], options);
}

/** Observe a spawned fixture without changing its streams, exit events or child-clock policy. */
export function startFixtureChild(command, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const started = performance.now();
  const child = spawn(command, args, options);
  let stderr = '';
  let spawnError;
  child.stderr?.on('data', part => { stderr += part.toString(); });
  child.once('error', error => { spawnError = error; });
  child.once('close', (status, signal) => {
    if (status !== 0 || signal || spawnError) {
      child.fixtureFailure = reportFixtureChildFailure({ command, args, status, signal,
        elapsedMs: performance.now() - started, stderr, env: options.env ?? process.env,
        detail: spawnError?.message ?? '' });
    }
  });
  return child;
}
