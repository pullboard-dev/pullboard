/** Coordinator landing failures step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import * as store from './board.js';

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
  return gate.failures.length > 0 && gate.failures.every((failure) => failure.file && store.landingWaiverFor(state.board, failure, state.landingPorts));
}

/**
 * Read one stage's TAP strictly: test lines outside YAML blocks, each failure's file from its own
 * block, and a final `# fail N` that equals the failures read. Anything after that summary other
 * than summary counts or the package manager's own failure report means something else failed,
 * so the stage is unaccounted and null is returned [B3,R3].
 */
export function tapFailures(output, root) {
  const lines = output.split('\n');
  const failures = [];
  let yaml = null;
  let active = null;
  let version = false;
  let summary = null;
  let summaryAt = -1;
  let cancelled = 0;
  for (const [index, line] of lines.entries()) {
    if (yaml !== null) {
      if (line === `${yaml}...`) { yaml = null; continue; }
      const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/u.exec(line);
      if (active && location) {
        const path = location[1];
        const file = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//u, '');
        if (file && !file.startsWith('../') && !file.includes('\\')) active.file = file;
      }
      continue;
    }
    const block = /^(\s*)---\s*$/u.exec(line);
    if (block) { yaml = block[1]; continue; }
    if (/^TAP version \d+\s*$/u.test(line)) version = true;
    const failed = /^\s*not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed) {
      active = { name: failed[1].replace(/\s+#.*$/u, ''), file: null };
      if (/^(?:\.\/)?(?:test|tests)\/[^\r\n]+\.(?:[cm]?js|ts|py)$/u.test(active.name)) active.file = active.name.replace(/^\.\//u, '');
      failures.push(active);
      continue;
    }
    if (/^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    const count = /^# fail (\d+)\s*$/u.exec(line);
    if (count) { summary = Number(count[1]); summaryAt = index; }
    const stopped = /^# cancelled (\d+)\s*$/u.exec(line);
    if (stopped) cancelled = Number(stopped[1]);
  }
  if (yaml !== null || !version || summary === null || summary < 1 || summary !== failures.length || cancelled !== 0) return null;
  const trailer = lines.slice(summaryAt + 1).every((line) => !line.trim() || /^# [a-z_]+ \d+(?:\.\d+)?\s*$/u.test(line) || /^npm (?:ERR!|error|warn|notice)\b/u.test(line));
  return trailer ? failures : null;
}

/**
 * The failures that explain a red run, or null when anything else may have failed: the command
 * could not be split into stages, a stage did not finish, a stage exited other than 0 without
 * exactly 1 and a complete TAP account of its failures, or a pipeline in a stage had a component
 * that left no status or failed without its own complete TAP account. Waivers only ever subtract
 * these [B3,R3].
 */
export function accountedFailures(gate, root) {
  if (gate.isGreen || !Array.isArray(gate.stages) || !gate.stages.length) return null;
  // Only the authenticated worker checkout may relocate remote failure locations.
  const executionRoot = gate.executionRoot ?? root;
  const failures = [];
  for (const stage of gate.stages) {
    if (!Number.isInteger(stage.status)) return null;
    if (stage.pipeline !== undefined) {
      // In a pipeline each failing component must explain itself; a forwarded account credits no one else [B3,R3].
      const own = pipelineFailures(stage.pipeline, executionRoot);
      if (!own || (stage.status === 0) !== (own.length === 0)) return null;
      failures.push(...own);
      continue;
    }
    if (stage.status === 0) continue;
    const own = stage.status === 1 ? tapFailures(stage.output ?? '', executionRoot) : null;
    if (!own) return null;
    failures.push(...own);
  }
  return failures.length ? failures : null;
}

/**
 * The failures a pipeline's components account for themselves, or null. Every component must have
 * recorded its status, and every failing one must exit exactly 1 with a complete TAP account in its
 * own output. A setup step that fails beside a consumer printing a waived test's TAP has no account
 * of its own, so it is an independent red no waiver names, and it voids the run.
 */
function pipelineFailures(components, root) {
  if (!Array.isArray(components) || components.some((entry) => !Number.isInteger(entry?.status))) return null;
  const failures = [];
  for (const { status, output } of components.filter((entry) => entry.status !== 0)) {
    const own = status === 1 ? tapFailures(output ?? '', root) : null;
    if (!own) return null;
    failures.push(...own);
  }
  return failures;
}

/**
 * Pair every named failure of a red run with the live person waiver covering it, or return null.
 * One unnamed, unfiled or unwaived failure voids the whole run, so a waiver never hides another red [B3,R3].
 */
export function waivedFailures(board, failures, landingPorts) {
  if (!Array.isArray(failures) || !failures.length || failures.some((entry) => !entry.file)) return null;
  const covered = failures.map((failure) => ({ ...failure, waiver: store.landingWaiverFor(board, failure, landingPorts) }));
  return covered.every((entry) => entry.waiver) ? covered : null;
}

/** Project the live person waivers a landing run may read, so it does not stop early on one [B3]. */
export function liveWaiverProjection(board, landingPorts) {
  const now = board.clock.now().getTime();
  return store.landingWaivers(board, landingPorts).filter((waiver) => Date.parse(waiver.until) > now)
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
