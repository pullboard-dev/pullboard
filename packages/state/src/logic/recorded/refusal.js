/** Keep recorded refusal bytes independent of improvements to current recovery guidance [H16]. */
import { Refused } from '../../../../kernel/browser.js';

export const RECORDED_GENERIC_NEXT = 'Run pullboard help, correct the reported problem, and retry the command.';

/** Preserve the original refusal envelope used by ordered moves and sealed request receipts. */
export function recordedRefusal(error) {
  const message = String(error.message).replace(/^\[[A-Z][A-Z0-9_]*\] /, '');
  const match = /(?:; |\. |: )((?:run|install|upgrade|fix|restore|commit|merge|test|check out|set|give|use|reject|ask your coordinator|answer from the main checkout|the coordinator|to keep looking|never work around)\b[\s\S]*)/i.exec(message);
  return { code: error.code ?? 'INTERNAL', message,
    next: error.code === 'SPEC_BEHIND_MAIN' ? 'git merge main' : match?.[1] ?? RECORDED_GENERIC_NEXT };
}

/** Recompute display guidance derived by the old serializer without changing its durable receipt. */
export function refusalFromReceipt(error) {
  const next = error.next === recordedRefusal(error).next ? undefined : error.next;
  return new Refused(error.code, error.message, next);
}
