/** Shared private fixture child runner and redacted failure diagnostics [C7]. */
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import {
  delimiter,
  join,
} from 'node:path';
import { refuseTestsOnCoordinator } from '../../heavy.js';
import { loadMachineSettings } from '../../../config/index.js';
import {
  FIXTURE_MODEL,
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
} from '../../../git/tests/fixtures/child.js';

export { AGENT_SHELL_MARKERS } from '../../../kernel/index.js';
export { SSH_SHELL_MARKERS } from '../../../kernel/index.js';

// A bare node --test of a suite on the coordinator refuses here, before any fixture starts (#3899).
refuseTestsOnCoordinator({ read: loadMachineSettings });

// One copy of the four child-process helpers lives in the git cell's fixture child (#11364); this file re-exports them.
export {
  FIXTURE_MODEL,
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
};

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

let realGit;

/** The git that the system shim on this machine runs, found once per process; null when the shim is the git itself. */
export function realGitPath() {
  if (realGit !== undefined) return realGit;
  realGit = null;
  if (process.platform !== 'darwin') return realGit;
  const found = spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' });
  const path = found.status === 0 ? found.stdout.trim() : '';
  if (path && path !== '/usr/bin/git' && existsSync(path)) realGit = path;
  return realGit;
}

/**
 * The command a fixture child spawns. Why: git through the system shim costs two execs per call, so a plain git whose
 * environment PATH holds no git before the system one runs by its real path; a fixture's own bin/git wrapper still runs.
 */
export function fixtureGitCommand(command, env = process.env, real = realGitPath()) {
  if (command !== 'git' || !real) return command;
  for (const folder of String(env?.PATH ?? '').split(delimiter)) {
    if (folder === '/usr/bin') return real;
    if (folder && existsSync(join(folder, 'git'))) return command;
  }
  return real;
}

/**
 * Run an async fixture child, retaining redacted diagnostics without imposing a child clock.
 * The returned promise carries the spawned process as `.child`, so a caller can stop it.
 */
export function runFixtureChildAsync(command, args, options = {}) {
  const { onStderrChunk, ...spawnOptions } = options;
  const started = performance.now();
  const child = spawn(fixtureGitCommand(command, spawnOptions.env), args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
  activeFixtureChildren.add(child);
  let stdout = '';
  let rawStderr = '';
  const result = new Promise((resolveResult) => {
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
  result.child = child;
  return result;
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

/**
 * Run a Git fixture setup step; a `commit` skips the repository's hooks, which each cost a Node launch [C7].
 * Why: setup commits are not what a journey tests; a journey about hooks commits through tryGit or runFixtureGit and keeps them.
 */
export function runFixtureSetupGit(args, options = {}) {
  const setup = args[0] === 'commit' ? ['-c', 'core.hooksPath=/dev/null', ...args] : args;
  return runFixtureGit(setup, options);
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

/** Observe a spawned fixture, retaining otherwise ignored stderr without changing IPC or exit events. */
export function startFixtureChild(command, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const started = performance.now();
  const stderrIgnored = options.stdio === 'ignore' || (Array.isArray(options.stdio) && options.stdio[2] === 'ignore');
  const childOptions = stderrIgnored ? { ...options, stdio: options.stdio === 'ignore'
    ? ['ignore', 'ignore', 'pipe'] : options.stdio.map((stream, index) => index === 2 ? 'pipe' : stream) } : options;
  const child = spawn(command, args, childOptions);
  let stderr = '';
  let spawnError;
  child.stderr?.on('data', part => { stderr += part.toString(); });
  // Drain the private capture while preserving the caller's ignored-stream surface.
  if (stderrIgnored) { child.stderr = null; child.stdio[2] = null; }
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
