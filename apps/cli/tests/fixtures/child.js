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
