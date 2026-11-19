/** The ssh runner adapter: one run(runner, script) contract for the real ssh and for a fake that spawns nothing [C7,#1427]. */
import { Refused } from '../../../../kernel/light.js';
import { runRunnerScript } from '../pull/ssh.js';

/** Refuse a runner with no host, the same way in every form, before anything is spawned or answered. */
function requireHost(runner) {
  if (typeof runner?.host !== 'string' || !runner.host.trim()) {
    throw new Refused('SSH_RUNNER_HOST', 'the runner has no host to reach over ssh', 'give the runner a host, then run the script again');
  }
}

/** The part of a run's answer both forms share: { status, signal, stdout, stderr, error }, with stdout as bytes; error is null unless ssh itself failed. */
function answer({ status = null, signal = null, stdout = '', stderr = '', error = null } = {}) {
  return { status, signal, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)), stderr: String(stderr), error };
}

/**
 * The real form: run a script on a runner over ssh through runRunnerScript, with `spawnFn` (default node's spawn) so a
 * test can stub the process. Why: callers reach ssh through one object, so a later lint can refuse ssh access anywhere else [C7,#1427].
 * @param {{ spawnFn?: Function, ssh?: string, dir?: string, env?: object, timeoutMs?: number }} [defaults] Options every run starts from.
 * @returns {Readonly<{ run: (runner: { host: string }, script: string, options?: object) => Promise<{ status: number | null, signal: string | null, stdout: Buffer, stderr: string, error: string | null }> }>}
 */
export function createSshAdapter(defaults = {}) {
  return Object.freeze({
    async run(runner, script, options = {}) {
      requireHost(runner);
      return answer(await runRunnerScript(runner, script, { ...defaults, ...options }));
    },
  });
}

/**
 * The fake form: answer each run from `handler(runner, script)` ({ status, stdout, stderr }, text or bytes), spawning nothing.
 * @param {(runner: { host: string }, script: string) => object | Promise<object>} [handler] The answer; success with empty output by default.
 * @returns {Readonly<{ run: (runner: { host: string }, script: string) => Promise<{ status: number | null, signal: string | null, stdout: Buffer, stderr: string, error: string | null }> }>}
 */
export function createFakeSshAdapter(handler = () => ({ status: 0 })) {
  return Object.freeze({
    async run(runner, script) {
      requireHost(runner);
      return answer(await handler(runner, script));
    },
  });
}
