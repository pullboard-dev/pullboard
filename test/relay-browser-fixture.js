/** Relay Chrome operations share the native/network work budget [H16,C7]. */
import { startChrome as launchChrome } from './chrome-fixture.js';
import { relayWorkBudgetMs } from './relay-budget.js';
export { findChromeExecutable } from './chrome-fixture.js';
export { relayWorkBudgetMs } from './relay-budget.js';

/** Give ordinary relay page work its declared native and transport allowance. */
export async function startChrome(options = {}) {
  return launchChrome({ startupTimeoutMs: relayWorkBudgetMs(2),
    commandTimeoutMs: relayWorkBudgetMs(), taskTimeoutMs: relayWorkBudgetMs(), ...options });
}
