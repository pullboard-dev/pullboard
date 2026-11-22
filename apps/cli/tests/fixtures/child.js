import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runFixtureChildAsync } from '../../../../packages/gate/tests/fixtures/child.js';
/** The shared private fixture child runner now lives beside the gate's fixtures, so cell fixtures can use it without importing the CLI [C7]. */
export {
  privateFixtureFiles,
  safeFixtureDiagnostic,
  fixtureChildFailureContext,
  reportFixtureChildFailure,
  runFixtureChild,
  runFixtureChildAsync,
  cleanupFixtureChildren,
  fixtureChildMessage,
  runFixtureGit,
  runFixtureSetupGit,
  runFixtureExecFile,
  runFixtureExec,
  startFixtureChild,
  FIXTURE_MODEL,
} from '../../../../packages/gate/tests/fixtures/child.js';
/** The cell fixtures open boards through this one app door, which reaches the board package's fixture through the lib door [C7]. */
export { openKitBoard } from '../../../lib/tests/fixtures/board.js';

/** Run the native CLI in a private fixture process when a command clause requires its real entry and exit. */
export async function runNativeFixtureCli(args, options) {
  const env = options.env ?? { ...process.env };
  assert.ok(env.PULLBOARD_HOME, 'a native CLI probe owns a private fixture home');
  const running = runFixtureChildAsync(process.execPath,
    [fileURLToPath(new URL('../../pullboard.js', import.meta.url)), ...args], { encoding: 'utf8', ...options, env });
  const childPid = running.child.pid;
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'the native CLI started a real process');
  assert.notEqual(childPid, process.pid, 'the native CLI runs outside the test process');
  return { ...await running, childPid };
}
