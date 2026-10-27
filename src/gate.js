/** Public gate API; stage implementations live in separate concern-specific modules. */
export { withGateSlot } from './gate-slot.js';
export { performanceCores, testConcurrency, landingShardCount } from './test-concurrency.js';
export { gateStages } from './gate-stages.js';
export { runShell } from './shell-run.js';
export { digestOf, writeTimingProfile } from './gate-output.js';
export { sandboxBlockedOperation, sandboxBlockedScanner } from './sandbox-denial.js';
export {
  committedTree, isStampedGreen, refuseSandboxBlocked, runProfiledShell,
  runFrozenProof, runProfiledShellAsync, withLandingGateSlot, pinRunMain, runGate,
} from './gate-execution.js';
export { runStaticChecks } from './gate-static-check.js';
export { runSubmitGate } from './gate-submit.js';
export { deferredSelectionNote, submitGateReport, timingDigest, gateReport } from './gate-report.js';
