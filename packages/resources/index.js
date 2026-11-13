/** Resource leases, slots and machine memory admission behind one front door [C7,CD60,CD64]. */
export * from './light.js';
export * from './src/io/main.js';
export * from './src/io/admission/memory.js';
export { closeResourceConnections, reuseResourceConnections } from './src/io/connections.js';
export * from './src/io/home.js';
export * from './src/io/recovery.js';
export * from './src/io/runner/reasons.js';
export * from './src/io/lock.js';
export { keepHeartbeatWhileBlocked } from './src/io/heartbeat/blocked.js';
export { analysisArtifactDescriptor, readAnalysisArtifact, receiveAnalysisArtifact } from './src/io/artifact.js';

export { handoffDispatcherIdleLog, HANDOFF_DISPATCHER_OWNER_ENV, HANDOFF_WORKER_LIFELINE_ENV, HANDOFF_LIFELINE_RELEASE, onDispatcherLifelineEnd, releaseLifelines, HANDOFF_DISPATCHER_RESOURCE, HANDOFF_WORKER_RESOURCE, drainHandoffQueue, ensureHandoffDispatcher, finishRunningWorkers, exitedWithoutResult, HANDOFF_SWEEP_EVERY_MS, repeatingSweep, handoffQueueDirectory, handoffCapLine, handoffDispatcherHeartbeat, handoffDispatcherLog, handoffTicketWaiting, handoffTicketsWaiting, dropHandoffTicket, handoffWorkerCapacity, handoffWorkerCapacityDetail, queueHandoffLaunch, recordHandoffCap, reserveHandoffTicket, withHandoffQueueOrder } from './src/io/handoff/worker/cap.js';
export { claimHandoffRecoveryTurn, handoffDispatcherMayBeDead, recoverHandoffDispatcher } from './src/io/handoff/recovery.js';
export { HANDOFF_FOLDER_KEEP_MS, handoffRoots, pruneFinishedHandoffs, rememberHandoffRoot } from './src/io/handoff/prune.js';
export { closeGateSpans, gateSpanCause, openGateSpans, recordGateSpan, recordRunnerDispatch } from './src/io/spans/gate.js';
export { closeLandingSpans, landingSpan, landingSpanFolder, openLandingSpans, readLandingSpans, recordLandingSpan } from './src/io/spans/landing.js';
export { queuedElsewhere, recordHandoffQueue, replaceLostTicketOnce } from './src/io/handoff/owner.js';
export { sourceCacheJobGone } from './src/io/liveness.js';
