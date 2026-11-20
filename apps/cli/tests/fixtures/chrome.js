/** The shared Chrome launcher lives beside the gate fixtures, so package tests use it without importing the CLI app; app tests reach it here [C7]. */
import { RUNNER_PID_ENV } from '../../../../packages/gate/tests/fixtures/chrome.js';
export * from '../../../../packages/gate/tests/fixtures/chrome.js';
export { stableChrome } from './cockpit/stable.js';
export const CHROME_RUNNER_PID_ENV = RUNNER_PID_ENV;
