import { createHash } from 'node:crypto';
/** Bind the actual submit phase plan to each native receipt [C7,H16]. */
export function submitReusePlanDigest({ check, files, full, deferred, proofCommand }) {
  return createHash('sha256').update(JSON.stringify({ check: check || '', files: [...files].sort(), full, deferred, proofCommand: proofCommand || '' })).digest('hex');
}
