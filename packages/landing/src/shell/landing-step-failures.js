import { landingWaivers as nativeLandingWaivers } from '../core/landing-waivers.js';
import { landingWaiverFor as nativeLandingWaiverFor } from '../core/landing-waivers.js';
/** Coordinator landing failures step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import * as store from '../../../../src/board.js';

/** Derive failing test identities from TAP or spec reporter names and source locations, refusing unknown paths. */
export function landingFailures(output, root, { excludeCancelled = false } = {}) {
  const failures = [];
  let active = null;
  /** A reported path relative to the root, or null when it lies outside it. */
  const inRoot = (path) => {
    const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
    return file && !file.startsWith('../') && !file.includes('\\') ? file : null;
  };
  // The spec reporter (Node 24's default for node --test) names each failure as "test at <file>:<line>" then "✖ <name>".
  let specFile;
  for (const line of output.split('\n')) {
    const at = /^\s*test at (.+?):\d+(?::\d+)?\s*$/u.exec(line);
    if (at) { specFile = inRoot(at[1]); active = null; continue; }
    const spec = specFile !== undefined ? /^\s*\u2716 (.+?)(?: \([\d.]+m?s\))?\s*$/u.exec(line) : null;
    if (spec) { failures.push({ name: spec[1], file: specFile }); specFile = undefined; continue; }
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      failures.push(active);
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
    }
    const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
    if (active && location) {
      const file = inRoot(location[1]);
      if (file) active.file = file;
    }
    if (excludeCancelled && active && /^\s*failureType:\s*['"]?(?:cancelledByParent|subtestsFailed)['"]?\s*$/u.test(line)) active.omit = true;
  }
  const unique = new Map(failures.filter(entry => !entry.omit).map(({ file, name }) => [`${file}\0${name}`, { name, file }]));
  return [...unique.values()];
}

/** Whether current person waivers cover every named failure of this exact recorded run. */
export function coveredFailures(state, gate) {
  return gate.failures.length > 0 && gate.failures.every((failure) => failure.file && nativeLandingWaiverFor(state.board, failure, state.landingPorts));
}

export { tapFailures, accountedFailures } from '../../../gate/core.js';

/**
 * Pair every named failure of a red run with the live person waiver covering it, or return null.
 * One unnamed, unfiled or unwaived failure voids the whole run, so a waiver never hides another red [B3,R3].
 */
export function waivedFailures(board, failures, landingPorts) {
  if (!Array.isArray(failures) || !failures.length || failures.some((entry) => !entry.file)) return null;
  const covered = failures.map((failure) => ({ ...failure, waiver: nativeLandingWaiverFor(board, failure, landingPorts) }));
  return covered.every((entry) => entry.waiver) ? covered : null;
}

/** Project the live person waivers a landing run may read, so it does not stop early on one [B3]. */
export function liveWaiverProjection(board, landingPorts) {
  const now = board.clock.now().getTime();
  return nativeLandingWaivers(board, landingPorts).filter((waiver) => Date.parse(waiver.until) > now)
    .map((waiver) => ({ kind: waiver.kind ?? store.landingWaiverKind(waiver.test), test: waiver.test }));
}

/** Name one waived failure with the person's waiver, its reason and its expiry [B3]. */
export function waiverLine(failure) {
  const { waiver } = failure;
  if (waiver.quarantine) return `quarantined: ${failure.name} (${failure.file}) is a proven flake, reported but not blocking until repair #${waiver.quarantine.item} is verified`;
  return `waived: ${failure.name} (${failure.file}) by person waiver ${waiver.id} for ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test}: ${waiver.reason}; expires ${waiver.until}`;
}

/** Record every failure's exact live waiver rather than changing which tests the gate runs. */
export function waivedProof(state, gate) {
  if (!completeGate(gate) || gate.requiresGreen) return null;
  const failures = waivedFailures(state.board, gate.accounted, state.landingPorts);
  return failures ? { tree: gate.tree, failures: failures.map((entry) => ({ ...entry, waiver: entry.waiver.id })), logPath: gate.logPath } : null;
}
