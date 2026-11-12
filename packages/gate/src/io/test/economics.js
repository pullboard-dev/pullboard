/** Value-based test placement and audit planning; observations are inputs, never invented receipts [C7]. */
import { createHash } from 'node:crypto';

export const TEST_VALUE_DEFAULTS = Object.freeze({ escape: 1000, waitPerSecond: 1, falseRed: 60,
  landingEscape: 1000, landingWaitPerSecond: 0.1, delayPerHour: 1000, auditCost: 1 });

/** Reject invalid costs rather than silently turning a required gate into an empty selection. */
export function testValueCosts(value = {}) {
  const costs = { ...TEST_VALUE_DEFAULTS, ...value };
  for (const [name, cost] of Object.entries(costs)) {
    if (!Number.isFinite(cost) || cost < 0 || ['delayPerHour', 'auditCost'].includes(name) && cost === 0) {
      throw new TypeError(`test value cost ${name} must be nonnegative, with positive audit/delay costs`);
    }
  }
  return costs;
}

/** A missing reach declaration or actual CLI child launch is a journey; in-process dispatch remains a contract. */
export function journeyReason(closure, modules) {
  if (!closure?.files) return closure?.reason || 'undeclared reach';
  for (const path of closure.helpers ?? []) {
    const source = modules.get(path) ?? '';
    const cliPath = /(?:(?:bin|apps\/cli)\/pullboard\.[cm]?js|(?:['"]bin['"]|['"]apps['"]\s*,\s*['"]cli['"])\s*,\s*['"]pullboard\.[cm]?js['"])/u.test(source);
    const child = /\b(?:spawn(?:Sync)?|execFile(?:Sync)?|fork|runFixtureChild|runFixtureExecFile|startFixtureChild)\s*\(/u.test(source);
    if (cliPath && child) return `CLI-spawning boundary in ${path}`;
  }
  return ''; // Known reach stays a contract regardless of how many product areas it imports.
}

/** Use measured value when available; a known-reach contract starts at landing while observations remain unknown. */
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
  const tier = reason ? 'audit' : !known ? 'landing' : submitValue > 0 ? 'submit' : landingValue > 0 ? 'landing' : 'audit';
  return { file, tier, reason: reason || (!known ? 'unknown observations; initial landing coverage' : 'expected value'), runs, realCatches, flakes,
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
  if (![runCost, delayCost].every(value => Number.isFinite(value) && value >= 0) || !Number.isFinite(observationHours) || observationHours <= 0
      || !Number.isSafeInteger(escapes) || escapes < 0) throw new TypeError('invalid audit cadence inputs');
  const lambda = escapes / observationHours;
  return { lambda, hours: lambda === 0 || delayCost === 0 ? null : Math.sqrt(2 * runCost / (lambda * delayCost)),
    reason: delayCost === 0 ? 'zero delay cost; release/manual audit remains required' : lambda === 0 ? 'no audit-found main-red rate yet; release/manual audit remains required' : 'optimal expected cost' };
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
    planDigest: createHash('sha256').update(JSON.stringify([...keys].sort(([a], [b]) => a.localeCompare(b)))).digest('hex') };
}

/** Only a literal named-file Node command can be considered for the Main red sweep. */
export function mainRedCheckFiles(check) {
  if (typeof check !== 'string') return null;
  const command = check.startsWith('node apps/cli/src/io/run/tests.js ') ? 'node apps/cli/src/io/run/tests.js '
    : check.startsWith('node --test ') ? 'node --test ' : null;
  if (!command) return null;
  const files = check.slice(command.length).split(' ');
  if (!files.length || files.some(file => !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(file)
    || file.split('/').some(part => part === '.' || part === '..' || part.startsWith('-')))) return null;
  return [...new Set(files)].length === files.length ? files : null;
}

/** Read the check from the frozen bar itself and verify its stored digest. */
export function mainRedFrozenCheck(item) {
  if (!item || typeof item.item_frozen !== 'string' || typeof item.item_frozen_digest !== 'string'
    || createHash('sha256').update(item.item_frozen).digest('hex') !== item.item_frozen_digest) return null;
  let frozen;
  try { frozen = JSON.parse(item.item_frozen); } catch { return null; }
  return frozen && frozen.title === item.item_title && typeof frozen.check === 'string' ? frozen.check : null;
}

/** A red full audit can still establish a named file's green result, bound to this exact main tip. */
export function mainRedFilesProven(check, { plan, receipt, auditedHead, currentHead, auditedTree, currentTree }) {
  const files = mainRedCheckFiles(check);
  if (!files || !plan?.keys || !Array.isArray(plan.run) || !Array.isArray(plan.reused)
    || !/^[a-f0-9]{40,64}$/u.test(auditedHead ?? '') || auditedHead !== currentHead
    || !/^[a-f0-9]{40,64}$/u.test(auditedTree ?? '') || auditedTree !== currentTree || receipt?.head !== auditedHead
    || receipt.tree !== auditedTree || receipt.collection?.complete !== true || !Array.isArray(receipt.collection.files)
    || !Array.isArray(receipt.testOutcomes) || !Array.isArray(receipt.failures)) return false;
  return files.every(file => {
    if (!/^[a-f0-9]{64}$/u.test(plan.keys[file] ?? '')
      || ![...plan.run, ...plan.reused.map(row => row.file)].includes(file) || !receipt.collection.files.includes(file)
      || receipt.failures.some(row => row.file === file)) return false;
    const outcomes = receipt.testOutcomes.filter(row => row.file === file);
    return outcomes.length > 0 && outcomes.every(row => row.passed === true && row.skipped !== true);
  });
}

/** Preserve the existing public binding; native item creation reads its focused lower home. */
export { auditFailureItem } from '../../../../items/index.js';
