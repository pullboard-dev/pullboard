/** Resource leases, slots and machine memory admission behind one front door [C7,CD60,CD64]. */
export * from './src/shell/resources.js';
export * from './src/shell/memory-admission.js';
export { closeResourceConnections, reuseResourceConnections } from './src/shell/resource-connections.js';
export * from './src/shell/machine-home.js';
export * from './src/shell/resource-recovery.js';
export * from './src/shell/runner-wait-reasons.js';
export * from './src/shell/pool-lock.js';
export { keepHeartbeatWhileBlocked } from './src/shell/blocked-heartbeat.js';
export { analysisArtifactDescriptor, readAnalysisArtifact, receiveAnalysisArtifact } from './src/shell/analysis-artifact.js';

export { HANDOFF_DISPATCHER_OWNER_ENV, HANDOFF_DISPATCHER_RESOURCE, HANDOFF_WORKER_RESOURCE, drainHandoffQueue, ensureHandoffDispatcher, handoffQueueDirectory, handoffCapLine, handoffDispatcherLog, handoffTicketWaiting, handoffTicketsWaiting, dropHandoffTicket, handoffWorkerCapacity, handoffWorkerCapacityDetail, queueHandoffLaunch, recordHandoffCap, reserveHandoffTicket, withHandoffQueueOrder } from './src/shell/handoff-worker-cap.js';
export { recoverHandoffDispatcher } from './src/shell/handoff-dispatcher-recovery.js';
export { HANDOFF_FOLDER_KEEP_MS, handoffRoots, pruneFinishedHandoffs, rememberHandoffRoot } from './src/shell/handoff-folder-prune.js';
