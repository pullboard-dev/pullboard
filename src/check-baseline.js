import {
  timingFromOutput,
  timingRunner,
} from './timing.js';
export { provingCheck, sayCheckBaseline } from './check-baseline-format.js';
/** Observe a proposed check on an isolated copy of main before recording its move [V2,H16]. */
import { spawnSync } from './windows-child-process.js';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitChildEnv,
  mainCheckout,
  tryGit,
} from './git.js';
import { runShell } from './shell-run.js';
import { Refused } from './refused.js';

/**
 * Capture the command and coordinator commit once on the sender; replay only receives this observation.
 * A detached coordinator checkout cannot turn an unavailable baseline into a new gate.
 *
 * @param {string} root
 * @param {string} command
 * @param {{main?: string}} [options]
 * @returns {{command: string, main: string|null, result: string, reason?: string, seconds?: number}}
 */
export function checkBaseline(root, command, { main = undefined } = {}) {
  const captured = main === undefined ? prepareCheckBaseline(root, command) : { command, main, result: 'pending' };
  if (captured.result !== 'pending') return captured;
  const base = { command, main: captured.main };
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-check-base-'));
  const checkout = join(directory, 'checkout');
  const env = gitChildEnv(root);
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const selected = clone.status === 0 && spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', base.main], { cwd: checkout, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!selected || selected.status !== 0) return { ...base, result: 'unavailable', reason: 'temporary checkout could not be prepared' };
    const ran = runShell(checkout, command);
    return { ...base, result: ran.isGreen ? 'green' : 'red', seconds: ran.seconds, testEvidence: baselineTestEvidence(ran.output, command) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Retain observed case outcomes, distinguishing an absent named case from unrelated shell failure. */
export function baselineTestEvidence(output, command) {
  const tests = timingFromOutput(output, timingRunner(command)).tests;
  return { failed: [...new Set(tests.filter(test => !test.passed).map(test => test.name))].slice(0,512),
    passed: [...new Set(tests.filter(test => test.passed).map(test => test.name))].slice(0,512),
    noTestsMatched: /^run-tests: NO_TESTS_MATCHED:/mu.test(output) };
}

/**
 * Refuse a check the shell cannot parse, quoting the shell's own message. sh -n reads the command
 * without running it, so a stray quote is caught when the check is set instead of surfacing later
 * as a baseline red that looks like a test failing before the work [C7,V4].
 *
 * @param {string} command
 */
export function refuseCheckSyntax(command) {
  // /bin/sh is the shell checks run in (spawn's shell: true); a parse that cannot start is no verdict.
  const parsed = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  if (parsed.status === 0 || parsed.error || parsed.status === null) return;
  const said = `${parsed.stderr ?? ''}`.trim().split('\n').map((line) => line.trim()).filter(Boolean).join('; ') || `sh -n exited ${parsed.status}`;
  throw new Refused('CHECK_SYNTAX', `the check is not valid shell, so it would only ever run red: ${said}`);
}

/** Capture the authorized check's immutable base without running its shell command [V2,H16]. */
export function prepareCheckBaseline(root, command) {
  const primary = mainCheckout(root);
  if (!primary) return { command, main: null, result: 'unavailable', reason: 'coordinator checkout is detached' };
  if (!primary.commit) return { command, main: null, result: 'unavailable', reason: 'no main' };
  const base = { command, main: primary.commit };
  return { ...base, result: 'pending', request: randomUUID() };
}
