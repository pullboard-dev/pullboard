/** A top-level function, or a top-level arrow function bound to a const. */
const START = /^(?:export )?(?:(?:async )?function (\w+)\(|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>)/;

/**
 * Each top-level function's source by name, arrow functions included. A function declaration ends
 * at its closing brace; an arrow function ends where its statement does.
 *
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function functionsIn(source) {
  const bodies = new Map();
  let open = null;
  for (const line of source.split('\n')) {
    if (open) {
      open.lines.push(line);
      if (open.ends(line)) {
        bodies.set(open.name, open.lines.join('\n'));
        open = null;
      }
      continue;
    }
    const start = START.exec(line);
    if (!start) continue;
    const end = line.trimEnd();
    if (start[1] && end.endsWith('}')) bodies.set(start[1], line);
    else if (start[1]) open = { name: start[1], lines: [line], ends: (next) => next === '}' };
    else if (end.endsWith(';')) bodies.set(start[2], line);
    else if (end.endsWith('{')) open = { name: start[2], lines: [line], ends: (next) => next === '};' };
    else open = { name: start[2], lines: [line], ends: (next) => next.trimEnd().endsWith(';') };
  }
  return bodies;
}


/** Board functions handed a function to call, and the one the CLI and the runner hand them. */
export const MACHINE_CALLBACKS = {
  // Real higher command roots bind runnerExecutionServices; admission snapshots these functions onto the lease.
  'gate-execution.js': {
    'gateLease.executionServices.runners.runOnRunner': 'runners.js#runOnRunner',
    'gateLease.executionServices.runners.runOnRunnerAsync': 'runners.js#runOnRunnerAsync',
  },
  // Explicit item ports preserve these canonical authority and sandbox refusal paths.
  'reopen-authority.js': {
    verdictWithdrawalTarget: 'verdict-withdrawal.js#verdictWithdrawalTarget',
    computedConflictProblem: 'computed-conflict-receipt.js#computedConflictProblem',
  },
  'reject-clause.js': { deriveRigorCause: 'rigor-auto.js#deriveRigorCause' },
  'board-health.js': {
    normalizedDispatch: 'dispatch-health.js#normalizedDispatch',
    rejectedWorkReturns: 'rejected-work-return.js#rejectedWorkReturns',
  },
  'outside-verify.js': { verifyOutsideSandbox: 'sandbox-verify.js#verifyOutsideSandbox' },
  'item-authors.js': { strictReviewProblem: 'review-independence.js#strictReviewProblem' },
  // Native verification ports retain these exact receipt and projection guards.
  'proof-cli.js': { proofRunReceipt: 'proof-receipts.js#proofRunReceipt' },
  'proof-counters.js': {
    appendRigorCounter: 'rigor-counters.js#appendRigorCounter',
    ensureRigorCounters: 'rigor-counters.js#ensureRigorCounters',
  },
  // The native root supplies these setup guards through the physical store's explicit ports.
  'board-store.js': {
    readEventLogVersion: 'board-read-open.js#readEventLogVersion',
    boardNotWritable: 'board-access.js#boardNotWritable',
    boardBusyError: 'board-access.js#boardBusyError',
  },
  'board.js': {
    freeze: 'cli.js#freezer',
    'board.nativePorts.sealSourceAdvanceReturn': 'source-advance-origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': 'computed-conflict-receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': 'rigor-auto.js#deriveRigorCause',
    'board.nativePorts.recordAutomaticRigorDrafts': 'rigor-auto.js#recordAutomaticRigorDrafts',
    'board.nativePorts.newRigorNotices': 'rigor-notices.js#newRigorNotices',
    'board.nativePorts.rigorNoticeText': 'rigor-notices.js#rigorNoticeText',
    'board.nativePorts.landingEnvironment.requireVerdict': 'landing-environment-guards.js#requireVerdict',
    'board.nativePorts.landingEnvironment.requireBatch': 'landing-environment-guards.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': 'landing-environment-guards.js#requireRevision',
    'board.nativePorts.landingEnvironment.requireTrunk': 'landing-environment-guards.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': 'landing-environment-guards.js#requireStoredBatch',
  },
  'line-capacity-board.js': {
    nextFor: 'board.js#nextFor',
    reviewerChecks: 'board.js#reviewerChecks',
    reviewReleaseCooldown: 'board.js#reviewReleaseCooldown',
  },
};
