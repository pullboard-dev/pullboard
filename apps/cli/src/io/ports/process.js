/** @pullboard-module-loads apps/cli/src/io/hook/work.js */
/**
 * The process capabilities the CLI entry hands to apps/cli/src/io/main.js. The in-process entry and the resident board
 * process run commands with the same capabilities, so both compose them here [C7].
 */

/** Load the native board only when a command asks for it; the CLI process opens boards and reads ports, so it skips the library barrel's workers (gate, landing) [C7]. */
export function loadNativeBoard() {
  return import('../../../../lib/light.js').then(light => light.nativeBoard);
}

/** The queue-wait reporter is composed here so the CLI never imports the gate; the gate loads on the first wait line. */
export function gateWaitReporter(io) {
  let report;
  let ready;
  return (wait) => {
    if (report) return report(wait);
    // Lines queue on one shared load, so they print in the order they arrived.
    ready ??= import('../../../../../packages/gate/index.js').then(({ gateWaitReporter: reporter }) => { report = reporter(io); });
    return ready.then(() => report(wait));
  };
}

/** Compose process-only capabilities after a command actually requests them. */
export function loadProcessPorts() {
  return Promise.all([import('node:url'), import('../../../../../packages/outbox/light.js')]).then(([{ fileURLToPath }, { outboxFields }]) => ({
    outboxFields,
    /** Load the canonical guard only when a linked operation actually needs it. */
    withOutboxGuard: (...args) => import('../../../../../packages/outbox/index.js').then(({ withOutboxGuard }) => withOutboxGuard(...args)),
    replayConflictRecord: (...args) => import('../../../../../packages/outbox/index.js').then(({ replay }) => replay(...args)),
    remoteBoardMissing: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.remoteBoardMissing(...args)),
    uncertainUploadFailure: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.uncertainUploadFailure(...args)),
    decideUncertainBaseline: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.decideUncertainBaseline(...args)),
    checkpointPublisher: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.checkpointPublisher(...args)),
    relayOrdering: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.relayOrdering(...args)),
    checkpointInBackground: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.checkpointInBackground(...args)),
    scheduleCheckpoint: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.scheduleCheckpoint(...args)),
    requestCheckpointCheck: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.requestCheckpointCheck(...args)),
    outboxPolicy: () => import('../../../../../packages/outbox/index.js').then(m => ({ acknowledgedOperations: m.ACKNOWLEDGED_OPERATIONS, outboxQueueable: m.outboxQueueable })),
    flushOutbox: (...args) => Promise.all([import('../../../../../packages/outbox/index.js'), import('../outbox-shadow.js')]).then(([m, shadow]) => shadow.withOutboxShadow(m)).then(m => m.flushOutbox(...args)),
    queueMove: (...args) => Promise.all([import('../../../../../packages/outbox/index.js'), import('../outbox-shadow.js')]).then(([m, shadow]) => shadow.withOutboxShadow(m)).then(m => m.queueMove(...args)),
    outboxHasPendingCreatedItem: (...args) => import('../../../../../packages/outbox/index.js').then(m => m.outboxHasPendingCreatedItem(...args)),
    checkpointWorker: fileURLToPath(new URL('../../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url)),
    hookWorker: fileURLToPath(new URL('../hook/work.js', import.meta.url)),
    /** Start only an actually requested sender; ordinary reads never load its modules. */
    launchRelaySender: (root, env) => {
      void import('../../../index.js').then(sender => sender.launchRelaySender(root, env)).catch(() => {});
    },
  }));
}
