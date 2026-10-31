/** Canonical named entry points for the planned cell; implementations retain their current owner [C7]. */
export { originalSession, recordFamilyDeclareActivation, seatFamily, withDerivedFamily } from '../../src/family-declaration.js';
export { workQueue } from '../../src/queue.js';
export { dependencyLabel } from '../../src/item-dependencies.js';
export { itemFiles, itemFileCollisions, addedFileCollisions, notifyFileGrowth } from './src/core/item-files.js';
export { outsideSource, saveOutsideSource, requireOutsideOwner, outsideSandboxProblem, outsideBuildProblem } from './src/core/outside-source.js';
export { OUTSIDE_SENSITIVE_PATHS, SENSITIVE_CELLS, planSensitivePaths, outsideSensitivePaths, outsideSensitivity } from './src/core/outside-sensitive.js';
export { setItem } from './src/core/item-fields.js';
export { correctedNoVerdictReopen } from './src/core/reopen-history.js';
export { requireLedger, recordItemSession, refuseSelfSession } from './src/shell/item-sessions.js';
export { requireOutsideReceipt } from './src/shell/outside-proof.js';
export { waitForSubmissionVerdict } from './src/shell/submit-wait.js';
export { briefFiles } from './src/core/brief.js';
