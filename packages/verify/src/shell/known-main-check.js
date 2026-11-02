/** Exact current-main failures with live repair owners may accompany an accept [V4,B3]. */
import { readFileSync } from 'node:fs';
import { compareMainFailures, failureSignatures, matchingMainFailures } from '../../../landing/index.js';
import { linkKnownMainReworks } from '../../../store/index.js';

/** Compare the complete red check after releasing its slot; unavailable evidence grants nothing. */
export async function knownMainCheck(root, check, { main, item, items, onWait, onMeasuredReceipt, runnerAdmission }) {
  if (check.state !== 'red' || !check.checked || check.executionSourceUnchanged !== true) return null;
  try {
    const output = check.outputPath ? readFileSync(check.outputPath, 'utf8') : check.output;
    const run = { ...check, isGreen: false, output,
      stages: [{ status: check.exitCode, output }] };
    const failures = failureSignatures(run, root);
    if (!failures?.length) return null;
    // Private checks report paths under their temporary checkout; use the already
    // validated repository-relative failure identities to select main's files.
    const profile = { tests: failures.map(row => ({ file: row.file, passed: false })) };
    const comparison = await compareMainFailures(root, profile, onWait, output, {
      commit: main, detailed: true, onMeasuredReceipt, runnerAdmission,
      execution: { executor: check.executionRunner ? { kind: 'ssh', host: check.executionRunner } : { kind: 'local' }, environment: check.environment },
    });
    const matched = matchingMainFailures(failures, comparison, main);
    return linkKnownMainReworks(matched, items(), item);
  } catch { return null; } // Preserve CHECK_RED when comparison, identity or ownership cannot be established.
}

/** Retain exact case identities and repair links in the immutable verdict without calling the raw check green. */
export function knownMainCheckNote(known) {
  return known ? `\nfrozen check remains red; identical on main ${known.main}:\n`
    + known.failures.map(row => `${row.file} :: ${row.name}; open Main red repair #${row.item}`).join('\n') : '';
}
