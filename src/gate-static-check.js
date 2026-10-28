/** Concern-specific gate stage; public callers keep the gate facade. */
import {
  withGateSlot,
} from './gate-slot.js';
import {
  checkNeedsGui,
} from './gui-admission.js';
import {
  Refused,
} from './refused.js';
import {
  browserFreeChecksEnabled,
} from './settings.js';
import {
  checkNeedsBrowser,
} from './browser-admission.js';
import {
  digestOf,
} from './gate-output.js';
import {
  refuseSandboxBlocked,
  runProfiledShell,
} from './gate-execution.js';
/** Quote a fixed executable or selected path without permitting shell expansion. */
export function commandWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Run the project's declared static guard before proof, retaining normal queue classification. */
export async function runStaticChecks(root, config, { agent, item = '', onWait, onBrowserFallback, executionServices } = {}) {
  const command = config.staticChecks?.trim();
  if (!command) return null;
  const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(root, command, { onFallback: onBrowserFallback });
  return withGateSlot(root, lease => {
    const run = runProfiledShell(root, command, { waitMs: lease.waitMs, artifactPrefix: 'pullboard-static-checks', persistLog: true, gateLease: lease });
    refuseSandboxBlocked(run);
    if (!run.isGreen) throw new Refused('GATE_RED', `static checks are red; fix the named source before running proof:\n${digestOf(run.output)}`);
    return run;
  }, { executionServices, browser, gui: await checkNeedsGui(root, command), agent, item, kind: 'static', itemCheck: true, shortEligible: true, onWait });
}

