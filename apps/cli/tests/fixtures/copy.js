/** The package-copy helpers live beside the gate fixtures, so package tests use them without importing the CLI app; app tests reach them here [C7]. */
import * as home from '../../../../packages/gate/tests/fixtures/package-copy.js';
export * from '../../../../packages/gate/tests/fixtures/package-copy.js';
export const COPY_FIXTURE_NAMES = Object.keys(home);
