/**
 * Every test process sees its own private machine, never the one it runs on [C7].
 *
 * A test's verdict must not depend on where it runs: the person's ~/.pullboard settings (gateSlots, browserSlots,
 * gate.shortSlots, registered runners), the account's resources.sqlite, a CI marker a runner sets, or the
 * instrumentation an SSH runner loads into every Node process. bin/run-tests.js applies this to each test run.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_PRELOAD_ENV } from '../../../kernel/index.js';
import { declareKnownNodeOption } from '../../../kernel/index.js';
import { declarePreloadSources } from '../../../kernel/index.js';
import { gateRuntimeCaptureSource } from '../core/preload-policy.js';
import { childJournalPreloadSource } from './child-journal-source.js';

/** Stands in for the OS account home when machine state falls back to it (packages/resources/src/shell/machine-home.js). */
export const ACCOUNT_HOME_ENV = 'PULLBOARD_ACCOUNT_HOME';

/** The launch guard an undeclared test file passes to its Node children (BROWSER_UNDECLARED). */
const SLOT_GUARD_IMPORT = `--import=${new URL('./browser-slot-guard.js', import.meta.url).href}`;

// The classifier lives in the kernel; gate declares the preloads it owns so only they count as known.
declareKnownNodeOption(SLOT_GUARD_IMPORT);
declarePreloadSources({ runner: childJournalPreloadSource, runtime: gateRuntimeCaptureSource });

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

export { RUNNER_PRELOAD_ENV, foreignNodeOptions } from '../../../kernel/index.js';
