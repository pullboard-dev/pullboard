/** Canonical named entry points for the planned cell; implementations retain their current owner [C7]. */
export { originalSession, recordFamilyDeclareActivation, seatFamily, withDerivedFamily } from '../../src/family-declaration.js';
export { workQueue } from '../../src/queue.js';
export { dependencyLabel } from '../../src/item-dependencies.js';
export { itemFileCollisions } from '../../src/item-files.js';
export { outsideSource, saveOutsideSource, requireOutsideOwner, outsideSandboxProblem, outsideBuildProblem } from './src/core/outside-source.js';
export { OUTSIDE_SENSITIVE_PATHS, SENSITIVE_CELLS, planSensitivePaths, outsideSensitivePaths, outsideSensitivity } from './src/core/outside-sensitive.js';
