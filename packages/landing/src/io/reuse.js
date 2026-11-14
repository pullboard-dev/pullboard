/** The test files landing still trusts from a green submit proof [C7, RFC 0007]. */

/**
 * The test files a green submit proof (deferred journeys or not) still answers for at the merged tree: each file the
 * submit ran whose own bytes and covered-package closure are unchanged. Why: landing reran the whole plan whenever the
 * proof carried deferred journeys, though only the journeys and the files whose closure moved need a run [C7,#3801].
 *
 * @param {{ proof: { files?: string[], deferredFiles?: string[] } | null | undefined,
 *   closureUnchanged: (file: string) => boolean }} input - closureUnchanged is true when the file and every package it covers match the submit
 * @returns {{ reuse: string[], rerun: string[] }} reuse lists proved files; rerun lists the submit's files that must run again
 */
export function reusableSubmitFiles({ proof, closureUnchanged }) {
  const deferred = new Set(proof?.deferredFiles ?? []);
  const reuse = [], rerun = [];
  for (const file of [...new Set(proof?.files ?? [])].sort()) {
    if (!deferred.has(file) && closureUnchanged(file)) reuse.push(file);
    else rerun.push(file);
  }
  return { reuse, rerun };
}
