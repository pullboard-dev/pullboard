/**
 * Every test process sees its own private machine, never the one it runs on [C7].
 *
 * A test's verdict must not depend on where it runs: the person's ~/.pullboard settings (gateSlots, browserSlots,
 * gate.shortSlots, registered runners), the account's resources.sqlite, a CI marker a runner sets, or the
 * instrumentation an SSH runner loads into every Node process. bin/run-tests.js applies this to each test run.
 */
import {
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeCaptureSource } from './execution-environment.js';
import { childJournalPreloadSource } from './child-journal-preload.js';

/** Stands in for the OS account home when machine state falls back to it (src/machine-home.js). */
export const ACCOUNT_HOME_ENV = 'PULLBOARD_ACCOUNT_HOME';

/** An SSH runner names the spawn-journal preload it puts in NODE_OPTIONS, so classifiers can tell it from a foreign one. */
export const RUNNER_PRELOAD_ENV = 'PULLBOARD_RUNNER_PRELOAD';

/** The launch guard a browser-free test file passes to its Node children (gate.browserByLaunch). */
const SLOT_GUARD_IMPORT = `--import=${new URL('./browser-slot-guard.js', import.meta.url).href}`;

/** The import a runner declares; its file must hold exactly the runner's journal source for that directory. */
const RUNNER_PRELOAD = /^--import=(file:\/\/\S+\/child-spawn-preload\.mjs)$/u;

/**
 * Whether a declared runner preload is the runner's own: the file's bytes must equal the source the runner writes
 * for that directory. A name or a declaration alone proves nothing, so any other content stays foreign.
 *
 * @param {string | undefined} declared PULLBOARD_RUNNER_PRELOAD
 * @returns {boolean}
 */
function runnerPreload(declared) {
  const url = RUNNER_PRELOAD.exec(declared ?? '')?.[1];
  if (!url) return false;
  try {
    const file = fileURLToPath(url);
    return readFileSync(file, 'utf8') === childJournalPreloadSource(dirname(file));
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EISDIR', 'ERR_INVALID_URL', 'ERR_INVALID_FILE_URL_PATH'].includes(error.code)) return false;
    throw error;
  }
}

/** Recognize only the exact child-runtime recorder, without trusting a caller's preload declaration. */
function runtimePreload(token) {
  const declared = /^--require=(.+)$/u.exec(token ?? '')?.[1];
  if (!declared) return false;
  try {
    const file = declared.startsWith('"') ? JSON.parse(declared) : declared;
    return typeof file === 'string' && file.endsWith('/test-runtime-preload.cjs')
      && readFileSync(file, 'utf8') === runtimeCaptureSource(dirname(file));
  } catch { return false; /* A missing or different recorder remains foreign and retains conservative admission. */ }
}

/**
 * Point every machine-state fallback of a test run at its sandbox and drop host markers tests model explicitly.
 * A test that wants a hostile machine builds one in its own fixture; it never inherits the real one.
 *
 * @param {NodeJS.ProcessEnv} env the test environment, changed in place
 * @param {string} sandbox the run's private directory
 * @returns {NodeJS.ProcessEnv}
 */
export function isolateTestMachine(env, sandbox) {
  const account = join(sandbox, 'account');
  mkdirSync(account, { recursive: true });
  env[ACCOUNT_HOME_ENV] = account;
  // A runner sets CI=1 and a person may pin their view port; tests that care set either explicitly.
  delete env.CI;
  delete env.PULLBOARD_VIEW_PORT;
  return env;
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
  const known = new Set([SLOT_GUARD_IMPORT]);
  if (runnerPreload(declared)) known.add(declared);
  return String(value ?? '').split(/\s+/u).filter(Boolean).some(token => !known.has(token) && !runtimePreload(token));
}
