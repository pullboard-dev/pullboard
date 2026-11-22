import { createHash } from 'node:crypto';

/** Bind native submit receipts to the exact selected plan, matching review's submitReusePlanDigest [C7,H16]. */
export function reusePlanDigest({ check, files, full = false, deferred = false, proofCommand }) {
  return createHash('sha256').update(JSON.stringify({ check: check || '', files: [...files].sort(), full, deferred, proofCommand: proofCommand || '' })).digest('hex');
}
