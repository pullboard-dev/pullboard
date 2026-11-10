/** Interpret complete native failures without changing their raw process result [C7,V4,H16]. */
import { readFileSync } from 'node:fs';
import { accountedFailures } from '../../light.js';
import { gateStages } from './stages.js';
import { timingAccountingStages } from './run/timing.js';
import { proofCounts } from '../../../verify/index.js';
import { testOutcomeFields } from './test/outcomes.js';
import { quarantineVerdict } from '../../../verify/index.js';

/** Unknown execution, incomplete identities or an unexplained shell component always remain blocking. */
export function quarantineRunVerdict(run, quarantines, { root, sourceClean, privateCommand, outcomeId, source } = {}) {
  if (!sourceClean || !quarantines?.length || run.exitCode !== 1 || run.timedOut || run.sandboxBlocked
    || run.cleanupUnverified || run.executionSourceUnchanged === false) return run;
  const outcomes = testOutcomeFields(run.testOutcomes);
  if (!outcomes) return run;
  let output;
  try { output = run.outputPath ? readFileSync(run.outputPath, 'utf8') : run.output; } catch { return run; }
  const counts = run.proofCounts ?? proofCounts(output ?? '');
  if (counts.failed < 1 || counts.failed !== outcomes.filter(row => !row.passed && !row.skipped).length
    || counts.passed !== outcomes.filter(row => row.passed && !row.skipped).length
    || counts.skipped !== outcomes.filter(row => row.skipped).length) return run;
  let stages = run.stages;
  if (!Array.isArray(stages)) {
    // The private-check protocol authenticates its phase status, not individual compound shell statuses.
    // A single readable command can use that real status; a compound command needs its own stage evidence.
    const plan = privateCommand && gateStages(privateCommand);
    if (run.state !== 'red' || !run.executed || !run.checked || plan?.length !== 1 || plan[0].pipeline.length !== 1) return run;
    stages = timingAccountingStages([{ status: run.exitCode, output }], outcomeId, source);
  }
  const failures = accountedFailures({ ...run, isGreen: false, stages }, run.executionRoot ?? root, { nativeLeaves: true });
  if (!failures || failures.length !== counts.failed || failures.some(failure => !outcomes.some(row =>
    row.file === failure.file && row.name === failure.name && !row.passed && !row.skipped))) return run;
  const verdict = quarantineVerdict(failures, quarantines, { green: false, exitCode: run.exitCode });
  if (!verdict) return run;
  return { ...run, rawIsGreen: false, isGreen: verdict.green, blockingVerdict: verdict, quarantineFailures: failures,
    ...(run.state ? { rawState: run.state, state: verdict.green ? 'pass' : run.state, green: verdict.green } : {}) };
}
