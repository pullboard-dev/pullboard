/** Shared private fixture child runner and redacted failure diagnostics [C7]. */
import { refuseTestsOnCoordinator } from '../../heavy.js';
import { loadMachineSettings } from '../../../config/index.js';
import {
  FIXTURE_MODEL,
  cleanupFixtureChildren,
  fixtureGitCommand,
  privateFixtureFiles,
  realGitPath,
  runFixtureChild,
  runFixtureChildAsync,
  runFixtureExec,
  runFixtureExecFile,
  runFixtureGit,
  runFixtureSetupGit,
  startFixtureChild,
} from '../../../git/tests/fixtures/child.js';

export { AGENT_SHELL_MARKERS } from '../../../kernel/index.js';
export { SSH_SHELL_MARKERS } from '../../../kernel/index.js';

// A bare node --test of a suite on the coordinator refuses here, before any fixture starts (#3899).
refuseTestsOnCoordinator({ read: loadMachineSettings });

// One copy of the child-process helpers lives in the git cell's fixture child (#11364, #12766); this file re-exports them.
export {
  FIXTURE_MODEL,
  cleanupFixtureChildren,
  fixtureGitCommand,
  privateFixtureFiles,
  realGitPath,
  runFixtureChild,
  runFixtureChildAsync,
  runFixtureExec,
  runFixtureExecFile,
  runFixtureGit,
  runFixtureSetupGit,
  startFixtureChild,
};

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

/** Prefer the structured child context in a failed assertion while keeping raw stderr untouched. */
export function fixtureChildMessage(result) {
  return result.failure ?? result.stderr ?? '';
}

