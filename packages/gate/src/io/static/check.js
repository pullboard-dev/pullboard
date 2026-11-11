/** Concern-specific gate stage; public callers keep the gate facade. */
import {
  withGateSlot,
} from '../slot.js';
import {
  checkNeedsGui,
} from '../gui/admission.js';
import {
  Refused,
} from '../../../../kernel/index.js';
import {
  browserFreeChecksEnabled,
} from '../../../../config/index.js';
import {
  checkNeedsBrowser,
} from '../browser/admission.js';
import {
  digestOf,
} from '../output.js';
import {
  refuseSandboxBlocked,
  runProfiledShellAsync,
} from '../execution.js';
import { receiptLine } from '../../../../git/index.js';
import { checkReceiptKey } from '../../../../git/index.js';
import { readCheckReceipt } from '../../../../git/index.js';
import { writeCheckReceipt } from '../../../../git/index.js';
import { fileURLToPath } from 'node:url';
/** Quote a fixed executable or selected path without permitting shell expansion. */
export function commandWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Run the project's declared static guard before proof, retaining normal queue classification. */
export async function runStaticChecks(root, config, { agent, item = '', onWait, onBrowserFallback, runnerAdmission = {}, executionServices, artifactDirectory, signal, onReceipt = (receipt, reused) => { if (reused) process.stderr.write(`${receiptLine(receipt)}\n`); } } = {}) {
  const command = config.staticChecks?.trim();
  if (!command) return null;
  // A green run on this exact tree, command, runner code and config is cited, not repeated (#2230).
  // The tree carries the project config file itself; the key adds the settings that come from accepted main.
  const key = checkReceiptKey(root, { kind: 'static', definition: command, config: { staticChecks: command, timeoutMs: config.check?.timeoutMs ?? null }, code: [fileURLToPath(import.meta.url)] });
  const recorded = readCheckReceipt(root, key);
  if (recorded) {
    onReceipt?.(recorded, true);
    return { isGreen: true, reused: true, receipt: recorded, output: '' };
  }
  const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(root, command, { onFallback: onBrowserFallback });
  return withGateSlot(root, async lease => {
    const run = await runProfiledShellAsync(root, command, { waitMs: lease.waitMs, artifactDirectory, artifactPrefix: 'pullboard-static-checks', persistLog: true, gateLease: lease, signal });
    refuseSandboxBlocked(run);
    if (!run.isGreen) throw new Refused('GATE_RED', `static checks are red; fix the named source before running proof:\n${digestOf(run.output)}`);
    const receipt = writeCheckReceipt(root, key, { by: agent ?? '' });
    if (receipt) onReceipt?.(receipt, false);
    return { ...run, receipt };
  }, { executionServices, browser, gui: await checkNeedsGui(root, command), agent, item, kind: 'static', itemCheck: true, shortEligible: true, onWait, signal, ...runnerAdmission });
}

