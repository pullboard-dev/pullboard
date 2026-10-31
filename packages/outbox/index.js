/** outbox front door: the cell's public modules behind one entry [C7,CD60]. */
export { uncertainUploadFailure, remoteBoardMissing, settleUncertainBaseline, decideUncertainBaseline } from "./src/shell/relay-baseline-settle.js";
export { checkpointPublisher } from "./src/shell/relay-checkpoint-publish.js";
export { checkpointInBackground, checkpointQuietMs, checkpointFiles, publisherHolding, alive, scheduleCheckpoint, requestCheckpointCheck, CHECKPOINT_BACKGROUND_ENV, CHECKPOINT_QUIET_ENV, CHECKPOINT_QUIET_MS } from "./src/shell/relay-checkpoint.js";
export { replay, transport } from "./src/shell/relay-conflict-record.js";
export { leaveConflictNotice, takeConflictNotices } from "./src/shell/relay-conflicts.js";
export { relayOrdering } from "./src/shell/relay-ordering.js";
export { outboxGuardFile, withOutboxGuard, withFileLock } from "./src/shell/relay-outbox-guard.js";
export { invertChangeset, undoQueued } from "./src/core/relay-outbox-undo.js";
export { outboxAhead, readOutbox, outboxHasPendingCreatedItem, writeOutbox, removeOutbox, describeMove, outboxEntrySummary, earlierMoves, keepRefusal, refusalLine, strayItemRefs, bindRefs, resolveMove, outboxFields, outboxQueueable, outboxWaiting, outboxGeneration, queueMove, flushOutbox, ITEM_SLOTS, ACKNOWLEDGED_OPERATIONS, outboxFile, outboxSummaryFile, readOutboxSummary } from "./src/shell/relay-outbox.js";
export { runRelaySender } from "./src/shell/relay-sender-worker.js";
