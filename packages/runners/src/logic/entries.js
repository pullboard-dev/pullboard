/** The worker entry a 0.9.3 tree holds; accepted only while that file exists, one release back. */
export const LEGACY_WORKER_ENTRY = 'apps/runner/src/io/scripts/worker.js';
/** The worker entry once it lives in its cell. */
export const WORKER_ENTRY = 'apps/runner/runner-worker.js';

/**
 * Whether a trusted-runtime manifest may name this worker entry: the legacy entry or the cell entry, and no other path.
 * Why: the manifest's entry is later hashed and run, so only the two known worker files may stand there.
 */
export function trustedWorkerEntry(entry) {
  return entry === LEGACY_WORKER_ENTRY || entry === WORKER_ENTRY;
}
