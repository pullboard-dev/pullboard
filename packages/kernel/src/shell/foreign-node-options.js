/** Classify NODE_OPTIONS as known or foreign, with the known preloads declared by the cells that own them [C7]. */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An SSH runner names the spawn-journal preload it puts in NODE_OPTIONS, so classifiers can tell it from a foreign one. */
export const RUNNER_PRELOAD_ENV = 'PULLBOARD_RUNNER_PRELOAD';

/** The import a runner declares; its file must hold exactly the runner's journal source for that directory. */
const RUNNER_PRELOAD = /^--import=(file:\/\/\S+\/child-spawn-preload\.mjs)$/u;

const knownTokens = new Set();
const preloadSources = { runner: null, runtime: null };

/**
 * Declare a NODE_OPTIONS token that is known to be this checkout's own, such as the launch guard.
 * Why: the classifier sits below the cells that own those preloads, so each owner declares its own; an undeclared token stays foreign.
 *
 * @param {string} token
 */
export function declareKnownNodeOption(token) {
  knownTokens.add(token);
}

/**
 * Declare how to rebuild the exact source of the runner journal preload and of the child-runtime recorder for a directory.
 * Why: a name or a declaration alone proves nothing, so a preload is known only when its bytes equal what its owner writes.
 *
 * @param {{ runner?: (directory: string) => string, runtime?: (directory: string) => string }} sources
 */
export function declarePreloadSources({ runner, runtime }) {
  if (runner) preloadSources.runner = runner;
  if (runtime) preloadSources.runtime = runtime;
}

/**
 * Whether a declared runner preload is the runner's own: the file's bytes must equal the source the runner writes
 * for that directory. A name or a declaration alone proves nothing, so any other content stays foreign.
 *
 * @param {string | undefined} declared PULLBOARD_RUNNER_PRELOAD
 * @returns {boolean}
 */
function runnerPreload(declared) {
  const url = RUNNER_PRELOAD.exec(declared ?? '')?.[1];
  if (!url || !preloadSources.runner) return false;
  try {
    const file = fileURLToPath(url);
    return readFileSync(file, 'utf8') === preloadSources.runner(dirname(file));
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EISDIR', 'ERR_INVALID_URL', 'ERR_INVALID_FILE_URL_PATH'].includes(error.code)) return false;
    throw error;
  }
}

/** Recognize only the exact child-runtime recorder, without trusting a caller's preload declaration. */
function runtimePreload(token) {
  const declared = /^--require=(.+)$/u.exec(token ?? '')?.[1];
  if (!declared || !preloadSources.runtime) return false;
  try {
    const file = declared.startsWith('"') ? JSON.parse(declared) : declared;
    return typeof file === 'string' && file.endsWith('/test-runtime-preload.cjs')
      && readFileSync(file, 'utf8') === preloadSources.runtime(dirname(file));
  } catch { return false; /* A missing or different recorder remains foreign and retains conservative admission. */ }
}

/**
 * Whether NODE_OPTIONS may load a module the classifier has not seen. This checkout's launch guard and an SSH
 * runner's proven journal preload are known; anything else is foreign, so the run is not short or browser-free.
 *
 * @param {string | undefined} value NODE_OPTIONS
 * @param {NodeJS.ProcessEnv} [env] where a runner's declared preload is read
 * @returns {boolean}
 */
export function foreignNodeOptions(value, env = process.env) {
  const declared = env[RUNNER_PRELOAD_ENV];
  const known = new Set(knownTokens);
  if (runnerPreload(declared)) known.add(declared);
  return String(value ?? '').split(/\s+/u).filter(Boolean).some(token => !known.has(token) && !runtimePreload(token));
}
