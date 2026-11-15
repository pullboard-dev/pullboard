import { createRequire } from 'node:module';
export { GENERATED_DOC_PATHS, generatedDocResolution, generatedDocCommand } from './src/logic/conflicts.js';
export { carriesConflict } from './src/logic/carriage.js';
export { mergeManifestRows, mergeableData, rowManifest } from './src/logic/manifest.js';
export { mainMergeFor, mainMergeLines, MAIN_MERGE_LABEL } from './src/io/trunk/conflict.js';

const requireModule = createRequire(import.meta.url);

/**
 * Why a merge-only item cannot land, loaded with its Git capture at the first call.
 * Why lazy: list and show reach this door for the merge label, and only a verdict read of a carried item asks this [C7,#7081].
 *
 * @param {...any} args - As the verdict module's mergeOnlyLandingProblem.
 * @returns {any}
 */
export function mergeOnlyLandingProblem(...args) { return requireModule('./src/io/only/verdict.js').mergeOnlyLandingProblem(...args); }
