/** The shared CLI-fixture kit lives beside the gate's fixtures, so package tests use it without importing the CLI app; app tests reach it here, and the board openers through fixtures/board.js [C7]. */
import { FIXTURE_MODEL } from '../../../../packages/gate/tests/fixtures/testkit.js';
export * from '../../../../packages/gate/tests/fixtures/testkit.js';
export const TESTKIT_MODEL = FIXTURE_MODEL;
