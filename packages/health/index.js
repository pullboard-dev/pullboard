/** Board health reports, doctor checks and stale-state capture behind one front door [C7,CD60,CD64]. */
export { doctrineProblems, doctorProblems } from './src/shell/doctor.js';
export { HEALTH_DEFAULTS, healthThresholds, boardHealth, healthReport, itemHistory, conflictFiles, healthLines } from './src/shell/health.js';
export { releaseBlockingItems } from './src/core/stale-state-blockers.js';
export { captureStaleState } from './src/shell/stale-state-capture.js';
export { prepareStaleObservation } from './src/shell/stale-state-command.js';
export { conditionalHoldFloor } from './src/core/stale-state-floor.js';
export { staleStateSnapshot } from './src/shell/stale-state-snapshot.js';

export { captureLapsedClaims, pinClaimHandoff } from './src/shell/stale-state-capture.js';
export { sweepClaims } from './src/shell/claim-sweep.js';
export { landingFailureFindings, landingFailureObservation } from './src/shell/landing-failure.js';
export { reviewFamilyCover, reviewFamilyBuildPause, REVIEW_COVER_WAIT_MS, REVIEW_COVER_BACKLOG, REVIEW_COVER_PAUSE_TAIL, shoutConflictedReviews } from './src/shell/review-family-cover.js';

export { claimHealthProjection, claimHealthSnapshot } from './src/shell/claim-health-projection.js';
