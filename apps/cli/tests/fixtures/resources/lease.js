/** This file-moved fixture lives beside the gate fixtures, so package tests use it without importing the CLI app; app tests reach it here [C7]. */
import * as home from '../../../../../packages/gate/tests/fixtures/admission/lease.js';
export * from '../../../../../packages/gate/tests/fixtures/admission/lease.js';
export const ADMISSION_FIXTURE_NAMES = Object.keys(home);
