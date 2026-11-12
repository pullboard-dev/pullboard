/**
 * Every test process sees its own private machine, never the one it runs on [C7].
 *
 * A test's verdict must not depend on where it runs: the person's ~/.pullboard settings (gateSlots, browserSlots,
 * gate.shortSlots, registered runners), the account's resources.sqlite, a CI marker a runner sets, or the
 * instrumentation an SSH runner loads into every Node process. apps/cli/src/io/run/tests.js applies this to each test run.
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
import { RUNNER_PRELOAD_ENV } from '../../../../kernel/index.js';
import { declareKnownNodeOption } from '../../../../kernel/index.js';
import { declareNodeOptionProofs } from '../../../../kernel/index.js';
import { foreignNodeOptions as classifyNodeOptions } from '../../../../kernel/index.js';
import { gateRuntimeCaptureSource } from '../../logic/preload.js';
import { PULLED_JOB_ENV } from './concurrency.js';
import { JOB_WORKERS_ENV } from '../../../../drive/light.js';
import { childJournalPreloadSource } from '../journal/source.js';

/** Stands in for the OS account home when machine state falls back to it (packages/resources/src/io/home.js). */
export const ACCOUNT_HOME_ENV = 'PULLBOARD_ACCOUNT_HOME';

/** The launch guard an undeclared test file passes to its Node children (BROWSER_UNDECLARED). */
const SLOT_GUARD_IMPORT = `--import=${new URL('../browser/guard.js', import.meta.url).href}`;

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
      && readFileSync(file, 'utf8') === gateRuntimeCaptureSource(dirname(file));
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
  // A pulled job's marker widens only the run that holds the runner, never a run a test starts.
  delete env[PULLED_JOB_ENV];
  delete env[JOB_WORKERS_ENV];
  return env;
}

// The classifier lives in the kernel; gate declares the preloads it owns.
declareKnownNodeOption(SLOT_GUARD_IMPORT);
declareNodeOptionProofs({ runner: runnerPreload, runtime: runtimePreload });

export { RUNNER_PRELOAD_ENV };

/** Whether NODE_OPTIONS may load a module the kernel's classifier has not seen; env defaults to this process. */
export function foreignNodeOptions(value, env = process.env) { return classifyNodeOptions(value, env); }
