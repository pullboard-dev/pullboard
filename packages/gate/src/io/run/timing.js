/** Source-bound observations of native suite phases, independent of their pass/fail authority [C7,H16]. */
import {
  tryGit,
  gitChildEnv,
} from '../../../../git/index.js';
import { randomUUID } from 'node:crypto';
import { runTimingFields } from '../../../../verify/light.js';
import {
  relative,
  resolve,
  sep,
} from 'node:path';

import { COLLECTION_REPORT_PREFIX } from '../../logic/collection/report.js';
import { formatCollectionReport } from '../../logic/collection/report.js';
import { parseCollectionReports } from '../../logic/collection/report.js';
import { readTestOutcomes } from '../test/outcomes.js';
import { keepSeatAlive } from '../keepalive.js';

export const TIMING_RUN_ID_ENV = 'PULLBOARD_TIMING_RUN_ID';
export const SUITE_TIMING_PREFIX = '# pullboard suite timing ';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Capture a clean committed source through the same native Git facts used by the gate. */
export function timingSource(root) {
  try {
    // Direct observations deliberately bypass the caller's invocation-scoped Git fact cache.
    const env = gitChildEnv(root);
    const status = tryGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], { env });
    if (status.status !== 0 || status.stdout) return null;
    const revision = tryGit(root, ['rev-parse', '--verify', 'HEAD'], { env });
    const treeRevision = tryGit(root, ['rev-parse', '--verify', 'HEAD^{tree}'], { env });
    if (revision.status !== 0 || treeRevision.status !== 0) return null;
    const head = revision.stdout, tree = treeRevision.stdout;
    return SHA.test(head ?? '') && SHA.test(tree ?? '') ? { head, tree } : null;
  } catch { return null; }
}

/** A missing source or an actual revision change cannot be converted into a bound timing observation. */
export function sameTimingSource(before, after) {
  return Boolean(before && after && before.head === after.head && before.tree === after.tree);
}

/** A suite's frame binds its actual Node process and phase observations to one source and invocation. */
export function suiteTimingFields(value) {
  const timing = runTimingFields(value);
  if (!timing || !ID.test(value.id ?? '') || !SHA.test(value.head ?? '') || !SHA.test(value.tree ?? '')
    || typeof value.full !== 'boolean' || timing.node === null) return null;
  return { version: 1, id: value.id, head: value.head, tree: value.tree, full: value.full,
    ...timing };
}

/** Emit diagnostics only after normalization; an unavailable observation never changes a test's result. */
export function formatSuiteTiming(value) {
  const timing = suiteTimingFields(value);
  return timing ? SUITE_TIMING_PREFIX + JSON.stringify(timing) + '\n' : '';
}

/** Require one complete source-matching frame; duplicates and malformed observations remain unknown. */
export function suiteTimingFromOutput(output, id, source) {
  if (!ID.test(id ?? '') || !source) return null;
  const matching = [];
  for (const line of String(output).split(/\r?\n/u)) {
    if (!line.startsWith(SUITE_TIMING_PREFIX)) continue;
    if (Buffer.byteLength(line) > 512 * 1024) return null;
    let value;
    try { value = JSON.parse(line.slice(SUITE_TIMING_PREFIX.length)); } catch { return null; }
    if (value?.id !== id) continue;
    const timing = suiteTimingFields(value);
    if (!timing || !sameTimingSource(source, timing)) return null;
    matching.push(timing);
  }
  return matching.length === 1 ? matching[0] : null;
}

/** Project only canonical invocation-bound diagnostics out of a component's TAP accounting view. */
export function timingAccountingOutput(output, id, source, { collectionId = id } = {}) {
  if (typeof output !== 'string') return output;
  const timing = suiteTimingFromOutput(output, id, source);
  if (!timing) return output;
  const canonical = formatSuiteTiming(timing).slice(0, -1);
  const chunks = output.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const matching = chunks.filter(chunk => chunk.replace(/\r?\n$/u, '') === canonical);
  if (matching.length !== 1) return output;
  const removed = new Set(matching);
  // A complete source-bound timing frame authenticates this component, never another pipeline member.
  const collection = parseCollectionReports(output, { id: collectionId, scope: 'suite', requireComplete: false });
  if (collection) {
    const reports = chunks.filter(chunk => {
      const line = chunk.replace(/\r?\n$/u, '');
      if (!line.startsWith(COLLECTION_REPORT_PREFIX)) return false;
      let value;
      try { value = JSON.parse(line.slice(COLLECTION_REPORT_PREFIX.length)); } catch { return false; }
      // Preserve the actual producer's file order; validation normalizes sets, formatting does not.
      return value?.id === collectionId && value.scope === 'suite' && value.shard === null
        && formatCollectionReport(value).slice(0, -1) === line;
    });
    if (reports.length === 1) removed.add(reports[0]);
  }
  return chunks.filter(chunk => !removed.has(chunk)).join('');
}

/** Keep raw stage objects intact while independently authenticating each component's accounting view. */
export function timingAccountingStages(stages, id, source, options) {
  if (!Array.isArray(stages)) return stages;
  return stages.map(stage => ({ ...stage,
    // A pipeline component must authenticate its own producer, never borrow a sibling's frame.
    testOutcomeRunId: typeof stage.output === 'string'
      && suiteTimingFromOutput(stage.output, id, source) && readTestOutcomes(stage.output, id) ? id : null,
    ...(typeof stage.output === 'string' ? { output: timingAccountingOutput(stage.output, id, source, options) } : {}),
    ...(Array.isArray(stage.pipeline) ? { pipeline: timingAccountingStages(stage.pipeline, id, source, options) } : {}) }));
}

/** Describe the controller's actual wall duration alongside only the suite phases it really observed. */
export function observedRunTiming(run, suite = null) {
  const wallMs = run.profile?.wallMs ?? run.remoteWallMs;
  return runTimingFields({ version: 1, node: suite?.node ?? null, wallMs,
    selectionMs: suite?.selectionMs ?? null, setupMs: suite?.setupMs ?? null,
    shards: suite?.shards ?? null, compareMs: suite?.compareMs ?? null });
}

/** Observe one runner invocation without changing its selection, cache, admission or exit semantics. */
export function beginSuiteTiming(root, args) {
  const started = performance.now(), source = timingSource(root);
  // The run's seat stays alive for as long as the run: the seat-gone rule otherwise reclaims its claim mid-test [B3].
  keepSeatAlive(root);
  const id = ID.test(process.env[TIMING_RUN_ID_ENV] ?? '') ? process.env[TIMING_RUN_ID_ENV] : randomUUID();
  const value = { version: 1, id, ...source, node: process.versions.node, full: false,
    selectionMs: null, setupMs: null, shards: [], compareMs: null };
  let forwarded = false, universe = null, allowed = true;
  /** Normalize native file summaries without accepting an out-of-root file as coverage. */
  const keys = files => [...new Set(files.map(file => relative(root, resolve(root, file)).split(sep).join('/')))].sort();
  /** Emit only the owning controller's one source-bound frame, including actual red and partial runs. */
  function finish() {
    if (forwarded || process.env.PULLBOARD_LANDING_SHARD || !sameTimingSource(source, timingSource(root))) return;
    process.stdout.write(formatSuiteTiming({ ...value, wallMs: performance.now() - started }));
  }
  process.once('exit', finish);
  return {
    id,
    /** Retain the original immutable universe before any action-cache selection rewrites arguments. */
    plan(files, full) { universe = keys(files); allowed = allowed && full && universe.length > 0; },
    /** Exclude a forwarding controller; the worker's own frame is retained unchanged instead. */
    forward() { forwarded = true; },
    /** Add only a duration measured across an actual entered planning or setup segment. */
    phase(name, start) { value[name] = (value[name] ?? 0) + performance.now() - start; },
    /** Retain every real attempt separately and require explicit completed-file coverage. */
    complete(result, files, elapsedMs) {
      value.shards.push({ shard: '1/1', attempt: 1, wallMs: elapsedMs });
      const selected = keys(files), completed = keys(result.completedFiles ?? []);
      value.full = allowed && result.collectionComplete === true && JSON.stringify(selected) === JSON.stringify(universe)
        && JSON.stringify(completed) === JSON.stringify(universe);
    },
    /** Fold actual shard attempts without summing overlapping attempt durations into the invocation wall. */
    sharded(result, files) {
      value.shards = result.shards.flatMap(shard => shard.attempts.map(attempt => ({ shard: shard.shard,
        attempt: attempt.attempt, wallMs: attempt.wallMs })));
      value.full = allowed && result.full === true && JSON.stringify(keys(files)) === JSON.stringify(universe);
    },
  };
}
