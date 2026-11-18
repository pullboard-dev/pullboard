/** The execution services stand-in lives beside the gate fixtures, so package tests use it without importing the CLI app; app tests reach it here [C7]. */
import { executionServices } from '../../../../../packages/gate/tests/fixtures/execution.js';
export * from '../../../../../packages/gate/tests/fixtures/execution.js';
export const EXECUTION_FIXTURE_HOME = 'packages/gate/tests/fixtures/execution.js';
