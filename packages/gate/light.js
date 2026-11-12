import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { readTestOutcomes } from './src/io/test/outcomes.js';
import { formatTestOutcomes } from './src/io/test/outcomes.js';

/** Accept only bounded worker-owned source measurements, never arbitrary receipt objects or paths. */
export function sourcePreparationFields(value) {
  const stages = ['cacheWaitMs', 'inventoryMs', 'transferMs', 'validateMs', 'materializeMs'];
  const operations = new Set(['init', 'fetch', 'checkout', 'index-pack', 'cat-file', 'rev-parse', 'rev-list',
    'for-each-ref', 'update-ref', 'merge-base', 'verify-pack', 'check-ref-format', 'config', 'status', 'unknown']);
  /** Preserve integer monotonic-clock durations and byte counts without coercing missing values. */
  const count = number => Number.isSafeInteger(number) && number >= 0;
  if (!value || value.version !== 1 || !count(value.packBytes) || !count(value.totalMs)
    || !value.stages || Object.keys(value.stages).length !== stages.length || stages.some(name => !count(value.stages[name]))
    || !value.git || typeof value.git !== 'object' || Array.isArray(value.git)
    || Object.entries(value.git).some(([operation, row]) => !operations.has(operation) || !row
      || !count(row.calls) || row.calls < 1 || !count(row.ms))
    || value.reusedCommit != null && (typeof value.reusedCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.reusedCommit))) return null;
  return { version: 1, packBytes: value.packBytes, totalMs: value.totalMs,
    stages: Object.fromEntries(stages.map(name => [name, value.stages[name]])),
    git: Object.fromEntries(Object.entries(value.git).map(([name, row]) => [name, { calls: row.calls, ms: row.ms }])),
    ...(Object.hasOwn(value, 'reusedCommit') ? { reusedCommit: value.reusedCommit } : {}) };
}

/**
 * The test runner's own phase-timing line (apps/cli/src/io/run/tests.js testRunPhaseClock), written to stderr as it exits.
 * Why: a gate stage merges stderr into its output, so this line follows TAP's final count on every run-tests stage;
 * read as an unknown trailer it left every red submit gate unaccounted, so no failure could ever be compared with
 * main and red-on-main cases always went back to the builder (#3794). It reports time only, never a failure.
 */
/** Node's own runtime warnings (an experimental-feature notice and its trace hint) print after the TAP summary and say nothing about test results. */
const NODE_WARNING = /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?[A-Za-z]*Warning: |^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/u;
const RUN_TESTS_PHASES = /^run-tests: phases (?:[a-z]+ \d+\.\ds, )+total \d+\.\ds$/u;

/**
 * Read one stage's TAP strictly: test lines outside YAML blocks, each failure's file from its own
 * block, and a final `# fail N` that equals the failures read. Anything after that summary other
 * than summary counts, the package manager's own failure report or the test runner's phase line means something else failed,
 * so the stage is unaccounted and null is returned [B3,R3].
 * Known-main comparisons alone may opt into cancelled children, with each cancellation explicitly counted.
 */
export function tapFailures(output, root, { outcomeRunId = null, nativeLeaves = false, allowCancelled = false } = {}) {
  const lines = output.split('\n');
  // Check every diagnostic position, including records before TAP's final count.
  const outcomes = readTestOutcomes(output, outcomeRunId);
  const nativeLines = new Set(outcomes ? formatTestOutcomes(outcomeRunId, outcomes).trimEnd().split('\n') : []);
  if (lines.some(line => line.startsWith('# pullboard test outcomes ') && !nativeLines.has(line))) return null;
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
      if (active && allowCancelled && /^\s*failureType:\s*['"]?cancelledByParent['"]?\s*$/u.test(line)) active.cancelled = true;
      if (active && nativeLeaves && outcomes && /^\s*failureType:\s*['"]?subtestsFailed['"]?\s*$/u.test(line)) active.aggregate = true;
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
  // Native outcomes authenticate actual test bodies. A describe/parent aggregate adds no independent failed body.
  const actual = allowCancelled ? failures.filter(row => !row.cancelled) : failures;
  if (allowCancelled && failures.filter(row => row.cancelled).length !== cancelled) return null;
  const leaves = nativeLeaves && outcomes ? actual.filter(row => !(row.aggregate && row.file
    && outcomes.some(outcome => outcome.file === row.file)
    && !outcomes.some(outcome => outcome.file === row.file && outcome.name === row.name))) : actual;
  if (yaml !== null || !version || summary === null || summary < 1 || summary !== leaves.length || !allowCancelled && cancelled !== 0) return null;
  if (nativeLeaves && outcomes && (outcomes.filter(row => !row.passed && !row.skipped).length !== leaves.length
    || leaves.some(row => !outcomes.some(outcome => outcome.file === row.file && outcome.name === row.name && !outcome.passed && !outcome.skipped)))) return null;
  // Only the controller's authenticated component may name a native diagnostic invocation.
  const trailer = lines.slice(summaryAt + 1).every((line) => !line.trim() || /^# [a-z_]+ \d+(?:\.\d+)?\s*$/u.test(line) || /^npm (?:ERR!|error|warn|notice)\b/u.test(line) || RUN_TESTS_PHASES.test(line) || NODE_WARNING.test(line) || nativeLines.has(line));
  return trailer ? nativeLeaves ? leaves.map(({ name, file }) => ({ name, file })) : actual : null;
}

/**
 * The failures that explain a red run, or null when anything else may have failed: the command
 * could not be split into stages, a stage did not finish, a stage exited other than 0 without
 * exactly 1 and a complete TAP account of its failures, or a pipeline in a stage had a component
 * that left no status or failed without its own complete TAP account. Waivers only ever subtract
 * these [B3,R3].
 */
export function accountedFailures(gate, root, { nativeLeaves = false, allowCancelled = false } = {}) {
  if (gate.isGreen || !Array.isArray(gate.stages) || !gate.stages.length) return null;
  // Only the authenticated worker checkout may relocate remote failure locations.
  const executionRoot = gate.executionRoot ?? root;
  const failures = [];
  for (const stage of gate.stages) {
    if (!Number.isInteger(stage.status)) return null;
    if (stage.pipeline !== undefined) {
      // In a pipeline each failing component must explain itself; a forwarded account credits no one else [B3,R3].
      const own = pipelineFailures(stage.pipeline, executionRoot, { nativeLeaves, allowCancelled });
      if (!own || (stage.status === 0) !== (own.length === 0)) return null;
      failures.push(...own);
      continue;
    }
    if (stage.status === 0) continue;
    const own = stage.status === 1 ? tapFailures(stage.output ?? '', executionRoot, { outcomeRunId: stage.testOutcomeRunId, nativeLeaves, allowCancelled }) : null;
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
function pipelineFailures(components, root, { nativeLeaves, allowCancelled }) {
  if (!Array.isArray(components) || components.some((entry) => !Number.isInteger(entry?.status))) return null;
  const failures = [];
  for (const { status, output, testOutcomeRunId } of components.filter((entry) => entry.status !== 0)) {
    const own = status === 1 ? tapFailures(output ?? '', root, { outcomeRunId: testOutcomeRunId, nativeLeaves, allowCancelled }) : null;
    if (!own) return null;
    failures.push(...own);
  }
  return failures;
}


// What the runner worker uses from gate, re-exported so apps/runner imports the light door and never gate's src.
export { chromeCloneDirectories } from './src/io/clone.js';
export { childJournalPreloadSource } from './src/io/journal/preload.js';
export { exactStart } from './src/io/journal/preload.js';
export { gateStages } from './src/io/stages.js';
export { stagedScript } from './src/io/stages.js';
export { readPipes } from './src/io/stages.js';
export { guiSession } from './src/io/gui/session.js';
export { TEST_RESULT_REQUEST_ENV } from './src/io/test/store.js';
export { TEST_RESULT_ORIGIN_ENV } from './src/io/test/store.js';
export { TEST_RESULT_STORE_ENV } from './src/io/test/store.js';
export { importTestResults } from './src/io/test/store.js';
export { packTestResults } from './src/io/test/store.js';
export { selectedTestResults } from './src/io/test/store.js';
export { startRunnerPhases } from './src/io/timing.js';
export { RunnerDropped } from './src/logic/runner-source.js';
export { runnerSource } from './src/logic/runner-source.js';
export { readStages } from './src/io/stages.js';
export { retainTestResultCompletion } from './src/io/test/store.js';
export { runnerPhaseFields } from './src/io/timing.js';
export { deriveTestRegistries } from './src/io/test/derived.js';
