/** Explicit opt-in smoke execution; this never activates a hook or writes a full-gate stamp [C7]. */
import { checkNeedsBrowser } from './browser-admission.js';
import { checkNeedsGui } from './gui-admission.js';
import {
  runProfiledShellAsync,
  withGateSlot,
} from './gate.js';
import { mainPolicy } from './trusted-policy-read.js';
import { Refused } from './refused.js';

/** Run only the accepted policy's explicit smoke command through ordinary native admission. */
export async function runPushReceiptSmoke(root, { agent, onWait } = {}) {
  const policy = mainPolicy(root);
  const command = policy.config.pushReceiptCheck?.smoke;
  if (typeof command !== 'string' || !command.trim()) {
    throw new Refused('NO_PUSH_SMOKE', 'record an explicit short pushReceiptCheck.smoke command in accepted pullboard.json before using the additive receipt check');
  }
  const browser = await checkNeedsBrowser(root, command);
  const gui = await checkNeedsGui(root, command);
  const run = await withGateSlot(root, lease => runProfiledShellAsync(root, command,
    { gateLease: lease, waitMs: lease.waitMs }), { browser, gui, agent, kind: 'test', onWait });
  return { policyCommit: policy.commit, command, ...run };
}
