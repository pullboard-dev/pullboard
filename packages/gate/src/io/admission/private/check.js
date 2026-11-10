/** Admit every command in a private check, including its supplemental proof files [C7,V4]. */
import { checkNeedsBrowser } from '../../browser/admission.js';
import { explicitCheckFiles } from '../../browser/admission.js';
import { checkNeedsGui } from '../../gui/admission.js';

/** Classify the complete execution before taking its single lease; a pure frozen check cannot hide a browser supplement. */
export async function privateCheckAdmission(root, commands, { commit, allowBrowserFreeChecks, onBrowserFallback } = {}) {
  const checks = [...new Set(commands.filter(command => typeof command === 'string' && command.trim()))];
  let browser = !allowBrowserFreeChecks || checks.length === 0, gui = false, shortEligible = checks.length > 0;
  for (const command of checks) {
    browser = await checkNeedsBrowser(root, command, { commit, onFallback: onBrowserFallback }) || browser;
    gui = await checkNeedsGui(root, command, { commit }) || gui;
    shortEligible = Boolean(await explicitCheckFiles(root, command, { commit })) && shortEligible;
  }
  return { browser, gui, shortEligible };
}
