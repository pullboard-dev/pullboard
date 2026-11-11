import { testTierReport } from './test/tier/selection.js';
/** Concern-specific gate stage; public callers keep the gate facade. */
import {
  join,
} from 'node:path';
import {
  receiptLine,
} from './receipt.js';
import {
  digestOf,
} from './output.js';
/** The durable words a submission and its reviewers read for an affected selection moved to the landing gate. */
export function deferredSelectionNote(files) {
  return `${files.length} affected test files deferred to the landing gate`;
}

/** Describe precisely which submission proof ran, including absent checks and full fallbacks. */
export function submitGateReport(gate) {
  const registry = gate.registryGuards?.length ? `; registry guards: ${gate.registryGuards.join(', ')}` : '';
  const check = (gate.check.checked ? `item check ${gate.check.green ? 'green' : 'red'} in ${gate.check.seconds}s` : 'no item check') + registry;
  if (gate.testTiers) return `${check}; ${testTierReport(gate.testTiers)}; ${gate.isGreen ? 'unit proof green' : gateReport(gate)}`;
  if (gate.deferred) {
    const reason = gate.reason ? `: ${gate.reason}` : '';
    const timings = timingDigest(gate.profile);
    const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
    const invariantsOnly = gate.deferFullFallback || Boolean(gate.deferredFiles);
    const invariants = gate.submitInvariants?.length ? 'submit invariants: ' + gate.submitInvariants.join(', ') + '; ' : '';
    const proof = gate.deferFullFallback
      ? `${invariants}full suite deferred to the landing gate${reason}`
      : gate.deferredFiles
        ? `${invariants}${deferredSelectionNote(gate.deferredFiles)} (over submitDeferAbove ${gate.deferAbove}): ${gate.deferredFiles.join(', ')}`
        : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}; full suite deferred to the landing gate${gate.submitInvariants?.length ? '; submit invariants: ' + gate.submitInvariants.join(', ') : ''}`;
    const label = invariantsOnly ? (gate.registryGuards?.length ? 'submit invariants and registry guards' : 'submit invariants') : 'affected tests';
    const result = invariantsOnly && !gate.submitInvariants?.length && !gate.registryGuards?.length ? '' : `; ${gate.isGreen ? `${label} green in ${gate.seconds}s` : gateReport(gate)}`;
    return `${check}; ${proof}${result}${detail}`;
  }
  const selection = gate.full ? `full gate: ${gate.reason}` : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}`;
  const timings = timingDigest(gate.profile);
  const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
  const result = gate.isGreen && !gate.full ? `affected tests green in ${gate.seconds}s${detail}` : gateReport(gate);
  return `${check}; ${selection}; ${result}`;
}

/** Show wall and queue wait for every run; rank files only when their durations were printed. */
export function timingDigest(profile) {
  if (!profile) return '';
  const measured = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : 'unavailable';
  const summary = `timing (${profile.runner ?? 'shell'}${profile.executionRunner ? ` on runner ${profile.executionRunner}` : ''}): wall ${measured(profile.wallMs)}, slot wait ${measured(profile.waitMs)}`;
  const rows = [...(profile.files ?? [])].filter(file => typeof file.path === 'string' && Number.isFinite(file.durationMs) && file.durationMs >= 0).sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
  const files = rows.length ? `\nslowest test files:\n${rows.map(file => `  ${file.path}: ${(file.durationMs / 1000).toFixed(2)}s`).join('\n')}` : '';
  const receipt = profile.receipt ? `\n${receiptLine(profile.receipt)}` : '';
  return `${summary}${receipt}${profile.unavailable ? `\n${profile.unavailable}` : ''}${files}`;
}

/**
 * What an agent sees of a gate run (V10): one line when green; when red, the digest and where the
 * whole output is.
 *
 * @param {{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }} gate
 * @returns {string}
 */
export function gateReport(gate) {
  const timings = timingDigest(gate.profile);
  const profilePath = timings && gate.profilePath ? `\ntiming profile: ${gate.profilePath}` : '';
  if (gate.blockingVerdict) {
    const refs = gate.blockingVerdict.quarantines.slice(0, 8).map(row => `#${row.item}/event ${row.eventId}: ${row.file.slice(0, 200)} :: ${row.name.slice(0, 240)}`).join('; ');
    const omitted = Math.max(0, gate.blockingVerdict.quarantines.length - 8);
    return `gate blocking verdict ${gate.isGreen ? 'green' : 'red'}; raw exit ${gate.exitCode}; quarantined failures: ${refs}${omitted ? `; ${omitted} more in receipt ${gate.proofReceiptId ?? gate.receiptId}` : ''}\nraw output: ${gate.log}${timings ? `\n${timings}` : ''}${profilePath}`;
  }
  if (gate.isGreen) {
    const summary = gate.isCached ? 'gate green (this tree already passed)' : `gate green in ${gate.seconds}s`;
    if (!gate.profile?.files?.length) return timings ? `${summary}; ${timings.replaceAll('\n', '; ')}${gate.profilePath ? `; timing profile: ${gate.profilePath}` : ''}` : summary;
    return `${summary}\n${timings}${profilePath}`;
  }
  return `gate red in ${gate.seconds}s:\n${(digestOf(gate.output) || '(gate produced no output)').replace(/^/gm, '  ')}\n${timings ? `${timings}\n` : ''}the whole output is in ${gate.log}${profilePath}`;
}
