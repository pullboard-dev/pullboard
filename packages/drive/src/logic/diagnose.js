/** Pure rules for flake-diagnose jobs: their kind, their key and which failures a red verdict hands them [C7]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/light.js';

/** The job kind of a flake diagnostic: one job per (tree, file, case), run after the gate's verdict. */
export const FLAKE_DIAGNOSE_KIND = 'flake-diagnose';

/**
 * The job id of the flake diagnostic for one failing case on one tree. The same (tree, file, case) always gives the
 * same id, so a second red gate on the same tree reuses the job instead of diagnosing the case again.
 *
 * @param {string} tree - The candidate's tree id.
 * @param {string} file - The failing test file.
 * @param {string} testCase - The failing case's title.
 * @returns {string}
 */
export function flakeDiagnoseKey(tree, file, testCase) {
  if (typeof tree !== 'string' || !tree || typeof file !== 'string' || !file || typeof testCase !== 'string' || !testCase) {
    throw new Refused('FLAKE_DIAGNOSE_KEY', 'A flake diagnostic is keyed by tree, file and case: pass all three as non-empty strings.');
  }
  return `${FLAKE_DIAGNOSE_KIND}:${createHash('sha256').update(JSON.stringify([tree, file, testCase])).digest('hex').slice(0, 32)}`;
}

/**
 * The distinct failing cases a red verdict hands to flake diagnostics, in the order given. Entries without a file and
 * a case are dropped: a shard that failed without naming a case has nothing a diagnostic can rerun.
 *
 * @param {unknown} failures - What the caller's `failures(collected)` returned.
 * @returns {{ file: string, case: string }[]}
 */
export function diagnoseTargets(failures) {
  if (!Array.isArray(failures)) return [];
  const seen = new Set();
  const targets = [];
  for (const failure of failures) {
    const file = failure?.file;
    const testCase = failure?.case;
    if (typeof file !== 'string' || !file || typeof testCase !== 'string' || !testCase) continue;
    const key = JSON.stringify([file, testCase]);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ file, case: testCase });
  }
  return targets;
}
