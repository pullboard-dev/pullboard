/** The light commits door: the contributor sign-off check, without the barrel's hooks and their node:sqlite load [C1,C7]. */
export { contributionSignoffProblem } from './src/io/signoff.js';
export { BASELINE_TABLES, TIER_TABLE, baselineRowChange, tierRowChange } from './src/logic/change/row/tier.js';
export { importOnlyChange, movedImportOnlyChange, movedImportTargets } from './src/logic/import-only-change.js';
export { hookStanding, hookWants, releaseBefore } from './src/logic/hook-compat.js';
export { secretsIn } from './src/logic/secrets.js';

/** Check a range's commit messages for a home-folder path or a Co-Authored-By trailer; the range module loads at the call, so this door's closure stays small [C1,C7]. */
export async function checkRangeMessages(...call) {
  return (await import('./src/io/signoff.js')).rangeMessageProblems(...call);
}
