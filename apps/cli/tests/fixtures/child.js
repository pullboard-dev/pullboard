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
  runFixtureExecFile,
  runFixtureExec,
  startFixtureChild,
  FIXTURE_MODEL,
} from '../../../../packages/gate/tests/fixtures/child.js';
