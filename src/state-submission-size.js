/** Validate the exact Git comparison observed by a submitting writer; readers never reconstruct it [R1,R2,H16]. */
import { Refused } from './refused.js';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const SUBMISSION_SIZE_METHOD = 'added-plus-deleted-no-renames';

/** Normalize optional observational metadata without guessing a missing legacy measurement. */
export function submissionSize(value, commit) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.base !== 'string' || typeof value.head !== 'string'
      || !COMMIT.test(value.base) || !COMMIT.test(value.head)
      || value.head !== commit || !Number.isSafeInteger(value.lines) || value.lines < 0
      || value.method !== SUBMISSION_SIZE_METHOD) {
    throw new Refused('SUBMISSION_PROOF', 'a submission size needs exact base and submitted head commits, a nonnegative changed-line count and its counting method; rerun submit with the current CLI');
  }
  return { base: value.base, head: value.head, lines: value.lines, method: SUBMISSION_SIZE_METHOD };
}
