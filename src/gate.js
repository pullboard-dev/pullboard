/** Public gate API; imported bindings preserve source-walk reachability across stage modules. */
import {
  withGateSlot,
} from './gate-slot.js';
export { withGateSlot };
import {
  performanceCores,
  testConcurrency,
  landingShardCount,
} from './test-concurrency.js';
export { performanceCores, testConcurrency, landingShardCount };
import {
  gateStages,
} from './gate-stages.js';
export { gateStages };
import {
  runShell,
} from './shell-run.js';
export { runShell };
import {
  digestOf,
  writeTimingProfile,
} from './gate-output.js';
export { digestOf, writeTimingProfile };
import {
  sandboxBlockedOperation,
  sandboxBlockedScanner,
} from './sandbox-denial.js';
export { sandboxBlockedOperation, sandboxBlockedScanner };
import {
  committedTree,
  isStampedGreen,
  refuseSandboxBlocked,
  runProfiledShell,
  runFrozenProof,
  runProfiledShellAsync,
  withLandingGateSlot,
  pinRunMain,
  runGate,
} from './gate-execution.js';
export { committedTree, isStampedGreen, refuseSandboxBlocked, runProfiledShell, runFrozenProof, runProfiledShellAsync, withLandingGateSlot, pinRunMain, runGate };
import {
  runStaticChecks,
} from './gate-static-check.js';
export { runStaticChecks };
import {
  runSubmitGate,
} from './gate-submit.js';
export { runSubmitGate };
import {
  deferredSelectionNote,
  submitGateReport,
  timingDigest,
  gateReport,
} from './gate-report.js';
export { deferredSelectionNote, submitGateReport, timingDigest, gateReport };
