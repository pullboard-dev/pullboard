/** The gate resource fixture lives beside the gate fixtures, so package tests use it without importing the CLI app; app tests reach it here [C7]. */
import { RUNNER } from '../../../../../packages/gate/tests/fixtures/resource.js';
export * from '../../../../../packages/gate/tests/fixtures/resource.js';
export const RESOURCE_FIXTURE_HOME = 'packages/gate/tests/fixtures/resource.js';
export const RESOURCE_FIXTURE_RUNNER = RUNNER;
