/** Board health reports, doctor checks and stale-state capture behind one front door [C7,CD60,CD64]. */
export { doctrineProblems, doctorProblems } from './src/io/doctor.js';
export { HEALTH_DEFAULTS, healthThresholds, boardHealth, healthReport, itemHistory, conflictFiles, healthLines } from './src/io/main.js';
export { flowWhy } from './src/logic/flow.js';
export { releaseBlockingItems } from './src/logic/stale/state/blockers.js';
export { captureStaleState } from './src/io/stale/state/capture.js';
export { prepareStaleObservation } from './src/io/stale/state/command.js';
export { conditionalHoldFloor } from './src/logic/stale/state/floor.js';
export { staleStateSnapshot } from './src/io/stale/state/snapshot.js';

export { captureLapsedClaims, pinClaimHandoff } from './src/io/stale/state/capture.js';
export { sweepClaims } from './src/io/claim/sweep.js';
export { unaccountedRedFindings, redIsUnaccounted, firstUnparsedLine } from './src/io/detector.js';
export { landingFailureFindings, landingFailureObservation } from './src/io/landing.js';
export { reviewFamilyCover, reviewFamilyBuildPause, reviewFamilyBacklog, shoutReviewCoverStuck, REVIEW_COVER_WAIT_MS, REVIEW_COVER_BACKLOG, REVIEW_COVER_PAUSE_TAIL, shoutConflictedReviews } from './src/io/cover.js';

export { claimHealthProjection, claimHealthSnapshot } from './src/io/claim/projection.js';
export { runScheduledClaimWatchdog } from './src/io/claim/sweep.js';
