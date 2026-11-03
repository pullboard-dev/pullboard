/** @pullboard-module-loads apps/lib/src/shell/cli-hook-work.js apps/lib/src/shell/submit-handoff-worker.js */
/**
 * The process capabilities the CLI entry hands to src/cli-main.js. The in-process entry and the resident board
 * process run commands with the same capabilities, so both compose them here [C7].
 */

/** Load the native board only when a command asks for it. */
export function loadNativeBoard() {
  return import('../apps/lib/index.js');
}

/** Compose process-only capabilities after a command actually requests them. */
export function loadProcessPorts() {
  return Promise.all([import('node:url'), import('../packages/outbox/index.js')]).then(([{ fileURLToPath }, { outboxFields }]) => ({
    outboxFields,
    /** Load the canonical guard only when a linked operation actually needs it. */
    withOutboxGuard: (...args) => import('../packages/outbox/index.js').then(({ withOutboxGuard }) => withOutboxGuard(...args)),
    replayConflictRecord: (...args) => import('../packages/outbox/index.js').then(({ replay }) => replay(...args)),
    remoteBoardMissing: (...args) => import('../packages/outbox/index.js').then(m => m.remoteBoardMissing(...args)),
    uncertainUploadFailure: (...args) => import('../packages/outbox/index.js').then(m => m.uncertainUploadFailure(...args)),
    decideUncertainBaseline: (...args) => import('../packages/outbox/index.js').then(m => m.decideUncertainBaseline(...args)),
    checkpointPublisher: (...args) => import('../packages/outbox/index.js').then(m => m.checkpointPublisher(...args)),
    relayOrdering: (...args) => import('../packages/outbox/index.js').then(m => m.relayOrdering(...args)),
    checkpointInBackground: (...args) => import('../packages/outbox/index.js').then(m => m.checkpointInBackground(...args)),
    scheduleCheckpoint: (...args) => import('../packages/outbox/index.js').then(m => m.scheduleCheckpoint(...args)),
    requestCheckpointCheck: (...args) => import('../packages/outbox/index.js').then(m => m.requestCheckpointCheck(...args)),
    outboxPolicy: () => import('../packages/outbox/index.js').then(m => ({ acknowledgedOperations: m.ACKNOWLEDGED_OPERATIONS, outboxQueueable: m.outboxQueueable })),
    flushOutbox: (...args) => import('../packages/outbox/index.js').then(m => m.flushOutbox(...args)),
    queueMove: (...args) => import('../packages/outbox/index.js').then(m => m.queueMove(...args)),
    outboxHasPendingCreatedItem: (...args) => import('../packages/outbox/index.js').then(m => m.outboxHasPendingCreatedItem(...args)),
    checkpointWorker: fileURLToPath(new URL('../apps/lib/src/shell/relay-checkpoint-worker.js', import.meta.url)),
    hookWorker: fileURLToPath(new URL('../apps/lib/src/shell/cli-hook-work.js', import.meta.url)),
    submitHandoffWorker: fileURLToPath(new URL('../apps/lib/src/shell/submit-handoff-worker.js', import.meta.url)),
    /** Start only an actually requested sender; ordinary reads never load its modules. */
    launchRelaySender: (root, env) => {
      void import('../apps/lib/index.js').then(sender => sender.launchRelaySender(root, env)).catch(() => {});
    },
  }));
}
