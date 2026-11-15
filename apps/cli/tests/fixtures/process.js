/** Awaited production CLI calls with isolated output and serialized process-global environment [C7,A1]. */
import { Readable } from 'node:stream';
import { main } from './native.js';
import { HOOK_WORKER } from '../../index.js';
import { launchRelaySender } from '../../index.js';

let pending = Promise.resolve();

/** Restore an exact environment, including absent keys; never remove identity markers selectively. */
function restoreEnvironment(saved) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) process.env[key] = value;
}

/**
 * Capture a command function using the same stream interface as the real binary. Calls sharing this
 * module serialize because legacy handlers still consult process.env. Callers must await completion;
 * unrelated tests must not mutate process globals concurrently with an explicit environment call.
 * Unexpected exceptions propagate after restoration, rather than becoming a fabricated CLI refusal.
 */
export function captureCommandInProcess(command, argv, { cwd = process.cwd(), env, input = '', personChannel } = {}) {
  const args = [...argv];
  const environment = env === undefined ? undefined : { ...env };
  const run = pending.then(async () => {
    const saved = { ...process.env };
    const directory = process.cwd();
    const exitCode = process.exitCode;
    let stdout = '', stderr = '';
    const stdin = Readable.from([input]);
    try {
      if (environment !== undefined) restoreEnvironment(environment);
      const status = await command(args, { cwd, stdin, hookWorker: HOOK_WORKER, hookTimeoutMs: 30_000, launchRelaySender, loadNativeBoard: () => import('../../../lib/index.js'),
        stdout: { isTTY: false, write(text) { stdout += String(text); return true; } },
        stderr: { isTTY: false, write(text) { stderr += String(text); return true; } },
        ...(personChannel === undefined ? {} : { personChannel }) });
      return { status, code: status, stdout, stderr, out: stdout, err: stderr, signal: null, failure: null };
    } finally {
      stdin.destroy();
      restoreEnvironment(saved);
      if (process.cwd() !== directory) process.chdir(directory);
      process.exitCode = exitCode;
    }
  });
  pending = run.then(() => undefined, () => undefined);
  return run;
}

/** Run actual production dispatch, including parsing, identity, ordered writes and refusals. */
export function runCliInProcess(argv, options) {
  return captureCommandInProcess(main, argv, options);
}

let scripts = 0;

/**
 * Run a module script in this process, as `node --input-type=module -e` would, and answer what it wrote and exited with.
 * Why: a relay journey's setup ran a Node child per script, about 40 s of launches in one file; the script is an ES module
 * source, so it imports by absolute URL and runs here under the same serialized environment as an awaited CLI call [C7,#8251].
 * The script's stdout writes, exit code, cwd, environment, fetch and subtle.verify are restored when it settles.
 *
 * @param {string} source - ES module source; it may use top-level await.
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, code: number, stdout: string, stderr: string, signal: null }>}
 */
export function runScriptInProcess(source, { cwd = process.cwd(), env } = {}) {
  const environment = env === undefined ? undefined : { ...env };
  const run = pending.then(async () => {
    const saved = { ...process.env };
    const directory = process.cwd();
    const exitCode = process.exitCode;
    const { fetch } = globalThis, { verify } = globalThis.crypto.subtle, { write } = process.stdout;
    let stdout = '', stderr = '';
    try {
      if (environment !== undefined) restoreEnvironment(environment);
      process.chdir(cwd);
      process.exitCode = undefined;
      process.stdout.write = chunk => { stdout += String(chunk); return true; };
      try { await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// run ${scripts += 1}`).toString('base64')}`); }
      catch (error) { stderr = String(error?.stack ?? error); process.exitCode = 1; }
      const code = Number(process.exitCode ?? 0);
      return { status: code, code, stdout, stderr, signal: null };
    } finally {
      process.stdout.write = write;
      globalThis.fetch = fetch;
      globalThis.crypto.subtle.verify = verify;
      restoreEnvironment(saved);
      if (process.cwd() !== directory) process.chdir(directory);
      process.exitCode = exitCode;
    }
  });
  pending = run.then(() => undefined, () => undefined);
  return run;
}
