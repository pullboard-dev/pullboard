/** outbox front door: the cell's public modules behind one entry [C7,CD60]. */
export { uncertainUploadFailure, remoteBoardMissing, settleUncertainBaseline, decideUncertainBaseline } from "./src/io/relay/settle.js";
export { checkpointPublisher } from "./src/io/relay/checkpoint/publish.js";
export { checkpointInBackground, checkpointQuietMs, checkpointFiles, publisherHolding, alive, scheduleCheckpoint, requestCheckpointCheck, CHECKPOINT_BACKGROUND_ENV, CHECKPOINT_QUIET_ENV, CHECKPOINT_QUIET_MS } from "./src/io/relay/checkpoint.js";
export { replay, transport } from "./src/io/relay/conflict.js";
export { leaveConflictNotice, takeConflictNotices } from "./src/io/relay/conflicts.js";
export { relayOrdering } from "./src/io/relay/ordering.js";
export { outboxGuardFile, withOutboxGuard, withFileLock } from "./src/io/relay/guard.js";
export { invertChangeset } from "./src/logic/undo.js";
export { undoQueued } from "./src/io/relay/undo.js";
export { outboxAhead, readOutbox, outboxHasPendingCreatedItem, writeOutbox, removeOutbox, describeMove, outboxEntrySummary, earlierMoves, keepRefusal, refusalLine, strayItemRefs, bindRefs, resolveMove, outboxFields, outboxQueueable, outboxWaiting, outboxGeneration, queueMove, flushOutbox, ITEM_SLOTS, ACKNOWLEDGED_OPERATIONS, outboxFile, outboxSummaryFile, readOutboxSummary } from "./src/io/relay.js";
export { runRelaySender } from "./src/io/relay/worker.js";
