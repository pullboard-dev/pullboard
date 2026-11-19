/** The bounded Chrome shutdown lives beside the gate fixtures; app tests reach it here [C7]. */
import { quitOwnedChrome } from '../../../../../packages/gate/tests/fixtures/chrome/shutdown.js';
export * from '../../../../../packages/gate/tests/fixtures/chrome/shutdown.js';
export const CHROME_QUIT = quitOwnedChrome;
