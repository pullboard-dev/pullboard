/** Value-based test placement and audit planning; observations are inputs, never invented receipts [C7]. */
import { createHash } from 'node:crypto';

export const TEST_VALUE_DEFAULTS = Object.freeze({ escape: 1000, waitPerSecond: 1, falseRed: 60,
  landingEscape: 1000, landingWaitPerSecond: 0.1, delayPerHour: 1000, auditCost: 1 });

/** Reject invalid costs rather than silently turning a required gate into an empty selection. */
export function testValueCosts(value = {}) {
  const costs = { ...TEST_VALUE_DEFAULTS, ...value };
  for (const [name, cost] of Object.entries(costs)) {
    if (!Number.isFinite(cost) || cost <= 0) throw new TypeError(`test value cost ${name} must be positive`);
  }
  return costs;
}

/** A missing reach declaration or a CLI-launching test-side helper is a journey, irrespective of apparent value. */
export function journeyReason(closure, modules) {
  if (!closure?.files) return closure?.reason || 'undeclared reach';
  for (const path of closure.helpers ?? []) {
    const source = modules.get(path) ?? '';
    if (source.includes('bin/pullboard.js') || source.includes('bin/pullboard.mjs')) return `CLI-spawning boundary in ${path}`;
  }
  const areas = new Set(closure.packages ?? closure.files.filter(path => /^(?:src|relay)\//u.test(path)).map(path => {
    const parts = path.split('/');
    return parts[0] === 'relay' ? 'relay' : parts.length > 2 ? parts.slice(0, 2).join('/') : 'src';
  }));
  return areas.size >= 3 ? 'reaches three or more product areas' : '';
}

/** Place a file with the strict expected-value inequality; unknown measurements stay in the audit. */
export function placeTest(file, observation, { reason = '', costs: input = {} } = {}) {
  const costs = testValueCosts(input);
  const { runs = null, realCatches = null, flakes = null, meanRuntimeMs = null, edits = null,
    catchRate = null, flakeRate = null, lastObservedRuntime = null } = observation ?? {};
  if (![runs, realCatches, flakes, edits].every(value => value === null || Number.isSafeInteger(value) && value >= 0)
      || ![catchRate, flakeRate].every(value => value === null || Number.isFinite(value) && value >= 0 && value <= 1)
      || meanRuntimeMs !== null && (!Number.isFinite(meanRuntimeMs) || meanRuntimeMs < 0)) throw new TypeError('invalid test observations');
  // The report counts repair episodes separately from catch-bearing executions. Several test names
  // caught in one run must never become a probability greater than one, or turn an unknown rate into zero.
  const fallback = lastObservedRuntime?.durationMs;
  const runtimeMs = meanRuntimeMs ?? (Number.isFinite(fallback) && fallback >= 0 ? fallback : null);
  const known = runs > 0 && catchRate !== null && flakeRate !== null && runtimeMs !== null;
  const submitValue = known ? catchRate * costs.escape - runtimeMs / 1000 * costs.waitPerSecond - flakeRate * costs.falseRed : null;
  const landingValue = known ? catchRate * costs.landingEscape - runtimeMs / 1000 * costs.landingWaitPerSecond - flakeRate * costs.falseRed : null;
  const tier = reason || !known ? 'audit' : submitValue > 0 ? 'submit' : landingValue > 0 ? 'landing' : 'audit';
  return { file, tier, reason: reason || (!known ? 'unknown observations' : 'expected value'), runs, realCatches, flakes,
    runtimeMs, runtimeSource: meanRuntimeMs !== null ? 'complete historical mean' : lastObservedRuntime,
    estimated: meanRuntimeMs === null && runtimeMs !== null, edits, catchRate, flakeRate, submitValue, landingValue };
}

/** Build the complete recorded placement in the audit, never by walking the repository on each change. */
export function placementReport({ closures, modules, observations = {}, costs = {}, at, head }) {
  const files = [...closures].map(([file, closure]) => ({ ...placeTest(file, observations[file], { reason: journeyReason(closure, modules), costs }),
    testInputs: closure.helpers ?? [file] }))
    .sort((a, b) => (b.submitValue ?? -Infinity) - (a.submitValue ?? -Infinity) || a.file.localeCompare(b.file));
  return { version: 1, at, head, costs: testValueCosts(costs), files,
    proposals: files.filter(row => !row.estimated && row.submitValue !== null && row.submitValue <= 0 && row.landingValue <= 0)
      .map(row => ({ file: row.file, action: 'person may approve deletion or rewrite' })) };
}

/** A gate only looks up its reached selection; absent index entries cannot become unproved submit tests. */
export function testsAtStage(files, report, stage) {
  if (!['submit', 'landing', 'audit'].includes(stage)) throw new TypeError('unknown test stage');
  // The caller supplies only the reached rows; the persisted index never reads the full report here.
  const tiers = new Map((report?.files ?? []).map(row => [row.file, row.tier]));
  return [...new Set(files)].filter(file => (tiers.get(file) ?? 'audit') === stage).sort();
}

/** Optimal interval in hours; no observed escapes means an unknown/infinite interval, not an invented rate. */
export function auditInterval({ runCost, escapes, observationHours, delayCost }) {
  if (![runCost, observationHours, delayCost].every(value => Number.isFinite(value) && value > 0)
      || !Number.isSafeInteger(escapes) || escapes < 0) throw new TypeError('invalid audit cadence inputs');
  const lambda = escapes / observationHours;
  return { lambda, hours: lambda === 0 ? null : Math.sqrt(2 * runCost / (lambda * delayCost)),
    reason: lambda === 0 ? 'no audit-found main-red rate yet; release/manual audit remains required' : 'optimal expected cost' };
}

/** Compare exact action keys only against the last complete green audit; unknown keys always run. */
export function incrementalAudit(keys, previous = null) {
  const green = previous?.complete === true && previous?.green === true && typeof previous.receiptId === 'string' && previous.receiptId ? previous.keys ?? {} : {};
  const run = [], reused = [];
  for (const [file, value] of keys) {
    if (value.key && green[file] === value.key) reused.push({ file, key: value.key, origin: previous.receiptId });
    else run.push(file);
  }
  return { run: run.sort(), reused: reused.sort((a, b) => a.file.localeCompare(b.file)),
    planDigest: createHash('sha256').update(JSON.stringify([...keys.keys()].sort())).digest('hex') };
}

/** Name every landing after the last green audit; a failed audit is not attributed to an arbitrary item. */
export function auditFailureItem({ failures, landings, sinceEventId = 0, lane }) {
  if (!failures.length) return null;
  const after = landings.filter(row => row.eventId > sinceEventId).map(row => ({ eventId: row.eventId, commit: row.commit, items: row.items }));
  return { lane, title: `Main red: scheduled audit (${failures.map(row => row.file).join(', ')})`,
    criterion: `The scheduled audit passes. Failures: ${failures.map(row => `${row.file}: ${row.name}`).join('; ')}. Landings since last green audit: ${JSON.stringify(after)}`,
    route: 'strong', audit: { sinceEventId, landings: after } };
}
