/** The runner holders helpers live beside the gate's fixtures, so package tests use them without importing the CLI app; app tests reach them here [C7]. */
import { waitForCondition } from '../../../../../packages/gate/tests/fixtures/runner/holders.js';
export * from '../../../../../packages/gate/tests/fixtures/runner/holders.js';
/** Wait helper the app's journeys import by its app path. */
export const waitUntil = waitForCondition;
