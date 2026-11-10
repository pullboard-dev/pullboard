/** Relay Chrome operations share the native/network work budget [H16,C7]. */
import { startChrome as launchChrome } from '../chrome.js';
import { relayWorkBudgetMs } from './budget.js';
export { findChromeExecutable } from '../chrome.js';
export { relayWorkBudgetMs } from './budget.js';

/** Give ordinary relay page work its declared native and transport allowance. */
export async function startChrome(options = {}) {
  return launchChrome({ startupTimeoutMs: relayWorkBudgetMs(2),
    commandTimeoutMs: relayWorkBudgetMs(), taskTimeoutMs: relayWorkBudgetMs(), ...options });
}
