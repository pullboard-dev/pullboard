import { landingWaivers as nativeLandingWaivers } from '../../logic/waivers.js';
import { landingWaiverFor as nativeLandingWaiverFor } from '../../logic/waivers.js';
/** Coordinator landing failures step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from '../completion.js';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import * as store from '../../../../store/index.js';

/** Derive failing test identities from TAP or spec reporter names and source locations, refusing unknown paths. */
export function landingFailures(output, root, { excludeCancelled = false } = {}) {
  const failures = [];
  let active = null;
  const cases = [];
  /** A reported path relative to the root, or null when it lies outside it. */
  const inRoot = (path) => {
    // A runner reports its own checkout path; the part after checkout/ is the repo file. The runner root is
    // `.pullboard-runner` on the minis and `pullboard-runner` on studio-host: a red there lost its file and held #3126 [C7].
    const runner = /\/\.?pullboard-runner\/jobs\/[^/]+\/checkout\/(.+)$/u.exec(path);
    if (runner) return runner[1];
    const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
    return file && !file.startsWith('../') && !file.includes('\\') ? file : null;
  };
  // Files the run's own watchdog stopped (hung, or past the whole-file wall): the stop is the machine's, not a test's.
  const stopped = new Set();
  // The spec reporter (Node 24's default for node --test) names each failure as "test at <file>:<line>" then "✖ <name>".
  let specFile;
  for (const line of output.split('\n')) {
    const watchdog = /run-tests: (?:HUNG|TIMEOUT) file "([^"]+)"/u.exec(line);
    if (watchdog) { const file = inRoot(watchdog[1]); if (file) stopped.add(file); }
    const subtest = /^(\s*)# Subtest:\s*(.+)$/u.exec(line);
    if (subtest) {
      while (cases.length && cases.at(-1).indent >= subtest[1].length) cases.pop();
      cases.push({ indent: subtest[1].length, name: subtest[2] });
      continue;
    }
    const at = /^\s*test at (.+?):\d+(?::\d+)?\s*$/u.exec(line);
    if (at) { specFile = inRoot(at[1]); active = null; continue; }
    const spec = specFile !== undefined ? /^\s*\u2716 (.+?)(?: \([\d.]+m?s\))?\s*$/u.exec(line) : null;
    if (spec) { active = { name: spec[1], file: specFile, spec: true }; failures.push(active); specFile = undefined; continue; }
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      const indent = /^\s*/u.exec(line)[0].length;
      const parents = cases.filter(entry => entry.indent < indent).map(entry => entry.name);
      if (parents.length) active.caseNames = [...parents, active.name];
      failures.push(active);
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
      else if (/\.test\.[cm]?js$/u.test(active.name) && isAbsolute(active.name)) active.file = inRoot(active.name);
    }
    const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
    if (active && location) {
      const file = inRoot(location[1]);
      if (file) active.file = file;
    }
    if (active?.spec && /^\s+\S/u.test(line)) (active.detailLines ??= []).push(line.trim());
    if (active && /^\s*\.\.\.\s*$/u.test(line)) active.diagnostic = false;
    if (active && !active.spec && /^\s*(?:error|expected|actual):/u.test(line)) active.diagnostic = true;
    if (active?.diagnostic && !/^\s*stack:/u.test(line)) (active.detailLines ??= []).push(line.trim());
    if (active && /^\s*stack:/u.test(line)) active.diagnostic = false;
    if (excludeCancelled && active && /^\s*failureType:\s*['"]?(?:cancelledByParent|subtestsFailed)['"]?\s*$/u.test(line)) active.omit = true;
  }
  // A nested case reports no location of its own; it fails in the file its outermost case failed in. Why: three such
  // rows with no file made a complete 17-red gate unaccountable and blocked a 16-item batch [C7].
  for (const entry of failures) {
    if (entry.file || !entry.caseNames?.length) continue;
    const parent = failures.find(other => other.file && !other.caseNames && other.name === entry.caseNames[0]);
    if (parent) entry.file = parent.file;
  }
  const unique = new Map(failures.filter(entry => !entry.omit).map(({ file, name, caseNames, detailLines }) => {
    const bytes = Buffer.from((detailLines ?? []).join('\n'));
    let end = Math.min(bytes.length, 2048);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const assertion = bytes.length > 2048 ? `${bytes.subarray(0, end).toString('utf8')}\n[assertion truncated at 2 KB]` : bytes.toString('utf8');
    // A file-level failure (the reporter names the file itself) that its watchdog stopped, or that the stop of its run
    // aborted, is recorded but is no test's verdict: its name is a checkout path no main comparison can ever match, and
    // charging or excusing it blocked every batch it appeared in [C7,#3167].
    const fileLevel = Boolean(file) && !caseNames && (name === file || inRoot(name) === file);
    const watchdog = fileLevel && (stopped.has(file) || (detailLines ?? []).some(line => /\bAbortError\b|This operation was aborted/u.test(line)));
    return [`${file}\0${JSON.stringify(caseNames ?? [name])}`, { name, file, ...(caseNames ? { caseNames } : {}), ...(assertion ? { assertion } : {}), ...(watchdog ? { watchdog: true } : {}) }];
  }));
  return [...unique.values()];
}

/**
 * The proof a red gate gives when every named failure is a watchdog-stopped file or a waived case: nothing a test
 * decided is red, so the batch lands and the stopped files are recorded with it. Null when any failure is a test's own.
 * Why: a stopped file is named by its checkout path, so it matched no main red and belonged to no item; the lander
 * neither landed nor returned the item and retried it every few minutes, 20 batches on two files in one day [C7,#3167].
 */
export function watchdogProof(state, gate) {
  const failures = Array.isArray(gate.failures) ? gate.failures : [];
  if (!failures.length || gate.requiresGreen) return null;
  const stopped = failures.filter(failure => failure.watchdog);
  if (!stopped.length) return null;
  if (unwaivedFailures(state.board, failures, state.landingPorts).length) return null;
  return { tree: gate.tree, failures: [], knownMain: [], watchdogStopped: stopped.map(({ file, name }) => ({ file, name })), logPath: gate.logPath };
}

/** Whether current person waivers cover every named failure of this exact recorded run. */
export function coveredFailures(state, gate) {
  return gate.failures.length > 0 && gate.failures.every((failure) => failure.file && nativeLandingWaiverFor(state.board, failure, state.landingPorts));
}

export { tapFailures, accountedFailures } from '../../../../gate/light.js';

/**
 * Pair every named failure of a red run with the live person waiver covering it, or return null.
 * One unnamed, unfiled or unwaived failure voids the whole run, so a waiver never hides another red [B3,R3].
 */
export function waivedFailures(board, failures, landingPorts) {
  if (!Array.isArray(failures) || !failures.length || failures.some((entry) => !entry.file)) return null;
  const covered = failures.map((failure) => ({ ...failure, waiver: nativeLandingWaiverFor(board, failure, landingPorts) }));
  return covered.every((entry) => entry.waiver) ? covered : null;
}

/**
 * The failures no live person waiver covers. Why: a waived file that is red on main must never stop a batch from
 * bisecting its own reds, or from landing the items that are green [C7,#2900].
 */
export function unwaivedFailures(board, failures, landingPorts) {
  // A watchdog-stopped file is the machine's stop, never a failure a batch can bisect or an item can own [C7,#3167].
  const list = (Array.isArray(failures) ? failures : []).filter((failure) => !failure.watchdog);
  // Ports with no quarantine reader carry no readable waiver, so every failure stays the batch's to judge [C7,#2945].
  if (typeof landingPorts?.quarantineWaivers !== 'function') return list;
  return list.filter((failure) => !(failure.file && nativeLandingWaiverFor(board, failure, landingPorts)));
}

/**
 * The failures a red, unaccounted landing gate can bisect on: every unwaived failure, when each names its file; null
 * when none remain or one is unnamed, which still needs a person to read the gate [C7,#2900].
 */
export function bisectableFailures(board, failures, landingPorts) {
  const own = unwaivedFailures(board, failures, landingPorts);
  // Named reds are enough to bisect on; an unnamed one rides along and the rebuilt green set's whole-plan run still
  // catches it. Why: one unnamed row among sixteen named ones blocked a whole batch for a person to read [C7].
  const named = own.filter((failure) => failure.file);
  return named.length ? named : null;
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

/**
 * The waived proof of a gate left incomplete only by waived files: every failure is in a file a live waiver covers,
 * and every planned file the run did not complete is one of them. Null otherwise, or when the run kept no collection
 * report naming its planned and completed files.
 * Why: apps/cli/journeys/submit/merge.test.js failed at file level (its failure named by its path, the file not completed),
 * so the run read as incomplete and its live file waiver was never read: #3768 held the trunk three times on 9 Nov [C7].
 *
 * @param {any} state
 * @param {any} gate
 * @returns {{ tree: string, failures: object[], logPath: string } | null}
 */
export function waivedFileProof(state, gate) {
  const report = gate.collectionReport;
  if (gate.timedOut || !Array.isArray(report?.plannedFiles) || !Array.isArray(report?.completedFiles)) return null;
  const failures = waivedFailures(state.board, gate.failures, state.landingPorts);
  if (!failures) return null;
  const waivedFiles = new Set(failures.map(entry => entry.file));
  const completed = new Set(report.completedFiles);
  const missing = report.plannedFiles.filter(file => !completed.has(file));
  if (missing.some(file => !waivedFiles.has(file) && !nativeLandingWaiverFor(state.board, { file, name: file }, state.landingPorts))) return null;
  return { tree: gate.tree, failures: failures.map(entry => ({ ...entry, waiver: entry.waiver.id })), logPath: gate.logPath };
}

/** Record every failure's exact live waiver rather than changing which tests the gate runs. */
export function waivedProof(state, gate) {
  if (gate.requiresGreen) return null;
  if (gate.knownMainProof && completeGate(gate, { allowCancelled: true })) return gate.knownMainProof;
  if (!completeGate(gate)) return waivedFileProof(state, gate);
  if (gate.knownMainProof) return gate.knownMainProof; // Red only in cases red on main: nothing to waive (#2586).
  if (gate.knownMain && !gate.accounted?.length) return null; // Own cases left unaccounted cannot become a waived proof.
  const failures = waivedFailures(state.board, gate.accounted, state.landingPorts);
  return failures ? { tree: gate.tree, failures: failures.map((entry) => ({ ...entry, waiver: entry.waiver.id })), logPath: gate.logPath } : null;
}
