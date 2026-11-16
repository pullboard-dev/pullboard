/** @pullboard-module-loads packages/link/index.js packages/keys/index.js apps/cli/tests/fixtures/native.js */
/** Run a relay journey's module script in this process, awaited, with its process globals restored [C7,#8251]. */
import { serializeInProcess } from '../process.js';

let scripts = 0;
/** The environment restored exactly, absent keys included. */
function restoreEnvironment(saved) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) process.env[key] = value;
}

/**
 * Run a module script in this process, as `node --input-type=module -e` would, and answer what it wrote and exited with.
 * Why: a relay journey's setup ran a Node child per script, about 40 s of launches in one file; the script is an ES module
 * source, so it imports by absolute URL here under the same serialized environment as an awaited CLI call [C7,#8251].
 * Only the script's own string writes to stdout are captured, since the test runner writes binary frames to the same stream.
 * Its exit code, cwd, environment, fetch and subtle.verify are restored when it settles.
 *
 * @param {string} source - ES module source; it may use top-level await.
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, code: number, stdout: string, stderr: string, signal: null }>}
 */
export function runScriptInProcess(source, { cwd = process.cwd(), env } = {}) {
  const environment = env === undefined ? undefined : { ...env };
  return serializeInProcess(async () => {
    const saved = { ...process.env };
    const directory = process.cwd();
    const exitCode = process.exitCode;
    const { fetch } = globalThis, { verify } = globalThis.crypto.subtle, { write } = process.stdout;
    let stdout = '', stderr = '';
    try {
      if (environment !== undefined) restoreEnvironment(environment);
      process.chdir(cwd);
      process.exitCode = undefined;
      process.stdout.write = function capture(chunk, ...rest) {
        if (typeof chunk !== 'string') return write.call(this, chunk, ...rest);
        stdout += chunk;
        return true;
      };
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
}
