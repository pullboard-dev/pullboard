/** Normalize execution facts without inventing missing runtime identities or test counts [C7,H16]. */
import { createHash } from 'node:crypto';
import { environmentProblem } from '../../../config/src/shell/config.js';
import { testOutcomeFields } from '../../core.js';
import { quarantineVerdictFields } from './quarantine-verdict.js';
import { tier1ShadowFields } from './tier1-shadow.js';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9-]{36}$/u;
const NODE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const MOST_FAILURES = 500;
const MOST_COLLECTION_FILES = 100000;

/** Require all three exact fields; unknown historical environments never match by inference. */
export function sameEnvironment(left, right) {
  return !environmentProblem(left) && !environmentProblem(right)
    && ['platform', 'arch', 'node'].every(key => left[key] === right[key]);
}

/** Validate bounded self-reported child rows; historical absence remains unknown. */
export function testRuntimeRows(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 100_000) return null;
  const rows = [];
  const pids = new Set();
  for (const row of value) {
    if (!row || Object.keys(row).sort().join(',') !== 'environment,file,pid'
      || !Number.isSafeInteger(row.pid) || row.pid < 1 || pids.has(row.pid) || environmentProblem(row.environment)
      || row.file !== null && (typeof row.file !== 'string' || !row.file || row.file.length > 4096 || /[\r\n\0\\]/u.test(row.file) || row.file.startsWith('/') || /^[A-Za-z]:/u.test(row.file)
        || row.file.split('/').some(part => !part || part === '.' || part === '..'))) return null;
    pids.add(row.pid);
    rows.push({ pid: row.pid, environment: { ...row.environment }, file: row.file });
  }
  return rows;
}

/** Keep the common actual test-child identity only when every selected child agrees; otherwise unknown. */
export function testRuntimeEnvironment(rows) {
  const checked = testRuntimeRows(rows);
  if (!checked) return null;
  const first = checked[0].environment;
  return checked.every(row => sameEnvironment(first, row.environment)) ? { ...first } : null;
}

/** Bounded single-line text, so a receipt never carries a log or a path outside the repo. */
function line(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value);
}

/**
 * Check and normalize a receipt's fields, in one fixed key order, or null when any field is missing or malformed. A
 * green run names no failure; a red run names the committed tests it could identify. It never throws: the gate's writer
 * must not fail a run over its receipt, and the board names its own refusal.
 *
 * @param {any} value
 * @returns {object | null} A canonical legacy gate or native proof receipt.
 */
export function receiptFields(value) {
  try { return checkedFields(value); } catch { return null; }
}

/** Validate observed collection coverage independently from green/red gate quality. */
function collectionFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.mode !== 'all'
    || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.batchId ?? '')
    || typeof value.complete !== 'boolean' || typeof value.full !== 'boolean'
    || !Array.isArray(value.files) || value.files.length > MOST_COLLECTION_FILES
    || value.files.some(file => !line(file, 4096) || file.startsWith('/') || /^[a-zA-Z]:/u.test(file)
      || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
    || !Number.isSafeInteger(value.plannedFiles) || value.plannedFiles < 0
    || !Number.isSafeInteger(value.completedFiles) || value.completedFiles < 0
    || !DIGEST.test(value.planDigest ?? '') || !DIGEST.test(value.completedDigest ?? '')) throw new TypeError('malformed collection receipt');
  const files = [...value.files].sort();
  if (files.length !== value.plannedFiles || new Set(files).size !== files.length
    || JSON.stringify(files) !== JSON.stringify(value.files)
    || createHash('sha256').update(JSON.stringify(files)).digest('hex') !== value.planDigest) throw new TypeError('collection plan does not match explicit files');
  if (value.complete && !(value.plannedFiles > 0 && value.plannedFiles === value.completedFiles
    && value.planDigest === value.completedDigest)) throw new TypeError('incomplete collection cannot claim completeness');
  return { version: 1, mode: 'all', batchId: value.batchId, full: value.full, files, complete: value.complete,
    plannedFiles: value.plannedFiles, completedFiles: value.completedFiles,
    planDigest: value.planDigest, completedDigest: value.completedDigest };
}

/** Optional producer metadata never invalidates a valid raw receipt; receivers reject a malformed present field. */
export function observedFailureSignatures(value, failures) {
  if (!value || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.failures)
    || value.failures.length !== failures.length || value.failures.some((row, index) => !row || typeof row !== 'object'
      || row.file !== failures[index].file || row.name !== failures[index].name || !DIGEST.test(row.signature ?? '')
      || row.firstError !== undefined && !line(row.firstError, 1024))) return null;
  return { version: value.version, failures: value.failures.map(({ file, name, signature, firstError }) => ({ file, name, signature,
    ...(firstError === undefined ? {} : { firstError }) })) };
}

/** The checks behind receiptFields; each malformed field throws, and receiptFields turns that into null. */
function checkedFields(value) {
  const bad = () => new TypeError('malformed gate receipt');
  const hasTestOutcomes = Object.hasOwn(value ?? {}, 'testOutcomes');
  const testOutcomes = hasTestOutcomes ? testOutcomeFields(value.testOutcomes) : null;
  if (hasTestOutcomes && !testOutcomes) throw bad();
  if (Object.hasOwn(value ?? {}, 'environment') && value.environment !== null && environmentProblem(value.environment)) throw bad();
  const proof = value?.version === 2 ? proofFields(value.proof) : null;
  const version = value?.version;
  const hasBlockingVerdict = Object.hasOwn(value ?? {}, 'blockingVerdict');
  const hasParticipation = Object.hasOwn(value ?? {}, 'participationDigest');
  if (hasParticipation && (version !== 1 || value.kind !== 'release' || !DIGEST.test(value.participationDigest ?? ''))
    || value?.kind === 'release' && !hasParticipation) throw bad();
  const hasCollection = Object.hasOwn(value ?? {}, 'collection');
  if (hasCollection && (version !== 1 || !['land', 'release'].includes(value.kind))) throw bad();
  const collection = hasCollection ? collectionFields(value.collection) : null;
  const hasTiming = Object.hasOwn(value ?? {}, 'timing');
  const hasFull = Object.hasOwn(value ?? {}, 'full');
  const timing = hasTiming ? runTimingFields(value.timing) : null;
  if (value?.kind === 'main-red' && (!hasTiming || value.full !== false || timing?.compareMs === null || !timing)) throw bad();
  if (hasTiming !== hasFull || hasTiming && (version !== 1 || !timing
    || !(value.full === null || typeof value.full === 'boolean'))) throw bad();
  const kinds = version === 2 ? ['check', 'submit', 'verdict', ...(hasBlockingVerdict ? ['land'] : [])] : ['gate', 'land', 'submit', 'release', ...(hasTiming ? ['suite', 'main-red'] : [])];
  if (!value || ![1, 2].includes(version) || version === 2 && !proof || !ID.test(value.id ?? '') || !kinds.includes(value.kind)
    || !(version === 2 && value.tree === null) && !SHA.test(value.tree ?? '')
    || !(version === 2 && value.head === null) && !SHA.test(value.head ?? '')
    || value.main !== null && !SHA.test(value.main ?? '') || !DIGEST.test(value.command ?? '')
    || typeof value.green !== 'boolean' || !Array.isArray(value.failures) || value.failures.length > MOST_FAILURES
    || value.green && value.failures.length > 0 || !line(value.at, 40) || !Number.isFinite(Date.parse(value.at))) throw bad();
  const failures = value.failures.map((entry) => {
    const file = entry?.file, name = entry?.name;
    if (!line(file, 4096) || file.startsWith('/') || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..') || !line(name, 8192)) throw bad();
    return { file, name };
  });
  const hasSignatures = Object.hasOwn(value, 'failureSignatures');
  const signed = hasSignatures ? observedFailureSignatures(value.failureSignatures, failures) : null;
  if (hasSignatures && !signed) throw bad();
  const blockingVerdict = hasBlockingVerdict ? quarantineVerdictFields(value.blockingVerdict,
    { green: value.green, exitCode: version === 2 ? proof?.exitCode : value.blockingVerdict?.exitCode, failures }) : null;
  if (hasBlockingVerdict && (!blockingVerdict || version === 2 && !proof.sourceClean
    || !testOutcomes || testOutcomes.filter(row => !row.passed && !row.skipped).length !== failures.length
    || failures.some(failure => !testOutcomes.some(row => row.file === failure.file && row.name === failure.name && !row.passed && !row.skipped)))) throw bad();
  const hasShadow = Object.hasOwn(value, 'shadow');
  const shadow = hasShadow ? tier1ShadowFields(value.shadow, value.green) : null;
  if (hasShadow && !shadow) throw bad();
  const load = value.load;
  if (!(version === 2 && load === null) && (!load || !Array.isArray(load.average) || load.average.length !== 3 || load.average.some((number) => !Number.isFinite(number) || number < 0)
    || !Number.isSafeInteger(load.cpus) || load.cpus < 1 || !Number.isSafeInteger(load.freeMB) || load.freeMB < 0)) throw bad();
  return { version, id: value.id, kind: value.kind, tree: value.tree, head: value.head, main: value.main, command: value.command,
    green: value.green, failures, load: load === null ? null : { average: [...load.average], cpus: load.cpus, freeMB: load.freeMB }, at: value.at,
    ...(proof ? { proof } : {}), ...(Object.hasOwn(value, 'environment') ? { environment: value.environment } : {}),
    ...(hasTestOutcomes ? { testOutcomes } : {}),
    ...(signed ? { failureSignatures: signed } : {}),
    ...(hasBlockingVerdict ? { blockingVerdict } : {}),
    ...(hasShadow ? { shadow } : {}),
    ...(hasCollection ? { collection } : {}), ...(hasParticipation ? { participationDigest: value.participationDigest } : {}),
    ...(hasTiming ? { full: value.full, timing } : {}) };
}



/** A bounded identity from the executor, never a command or an agent's narrative. */
function identity(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value);
}

/** Validate the native facts attached to a version-two gate receipt. */
export function proofFields(value) {
  const hasReuse = Object.hasOwn(value ?? {}, 'submitReuse');
  if (hasReuse && (value.submitReuse !== true || !/^[a-f0-9]{64}$/u.test(value.submitReusePlan ?? ''))) return null;
  if (!hasReuse && Object.hasOwn(value ?? {}, 'submitReusePlan')) return null;
  const hasPhase = Object.hasOwn(value ?? {}, 'submitPhase');
  if (hasPhase && !['criterion', 'proof', 'diagnostic'].includes(value.submitPhase)) return null;
  const hasDiagnosticAdmission = Object.hasOwn(value ?? {}, 'diagnosticAdmission');
  if (hasDiagnosticAdmission && !/^[a-f0-9-]{36}$/u.test(value.diagnosticAdmission ?? '')) return null;
  const hasAdmission = Object.hasOwn(value ?? {}, 'submitAdmission');
  if (hasAdmission && !/^[a-f0-9-]{36}$/u.test(value.submitAdmission ?? '')) return null;
  if (hasReuse && (!hasPhase || !hasAdmission || !['criterion', 'proof'].includes(value.submitPhase))) return null;
  if (!value || !Number.isSafeInteger(value.item) || value.item < 1
    || value.frozenDigest !== null && !/^[a-f0-9]{64}$/u.test(value.frozenDigest ?? '')
    || !identity(value.seat, 256) || value.runner !== null && !identity(value.runner)
    || value.exitCode !== null && !Number.isSafeInteger(value.exitCode)
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || typeof value.sourceClean !== 'boolean') return null;
  const environment = value.environment;
  if (environment !== null && (!environment || !identity(environment.node, 80)
    || !identity(environment.platform, 80) || !identity(environment.arch, 80))) return null;
  const hasTestRuntimes = Object.hasOwn(value, 'testRuntimes');
  const testRuntimes = hasTestRuntimes ? testRuntimeRows(value.testRuntimes) : null;
  if (hasTestRuntimes && value.testRuntimes !== null && testRuntimes === null) return null;
  // Captured test workers outrank the executor; a run with none (testRuntimes null) keeps the observed executor [C7,#2662].
  const actualEnvironment = testRuntimes ? testRuntimeEnvironment(testRuntimes) : environment;
  const hasShards = Object.hasOwn(value, 'shards');
  const shards = hasShards ? shardRows(value.shards) : null;
  if (hasShards && !shards) return null;
  const names = ['passed', 'failed', 'skipped'];
  if (!value.counts || !names.every(name => value.counts[name] === null
    || Number.isSafeInteger(value.counts[name]) && value.counts[name] >= 0)) return null;
  return { item: value.item, frozenDigest: value.frozenDigest,
    environment: actualEnvironment === null ? null : { node: actualEnvironment.node, platform: actualEnvironment.platform, arch: actualEnvironment.arch },
    seat: value.seat, runner: value.runner, exitCode: value.exitCode,
    counts: Object.fromEntries(names.map(name => [name, value.counts[name]])), durationMs: value.durationMs, sourceClean: value.sourceClean,
    ...(hasTestRuntimes ? { testRuntimes } : {}), ...(hasPhase ? { submitPhase: value.submitPhase } : {}), ...(hasAdmission ? { submitAdmission: value.submitAdmission } : {}), ...(hasDiagnosticAdmission ? { diagnosticAdmission: value.diagnosticAdmission } : {}), ...(hasReuse ? { submitReuse: true, submitReusePlan: value.submitReusePlan } : {}),
    ...(hasShards ? { shards } : {}) };
}

/**
 * Validate a sharded proof's per-shard results: two or more shards, each naming its repository-relative files, exit,
 * runner and duration. Why: one receipt covers the whole proof command (RFC 0007 keys reuse on the candidate, base and
 * tooling trees), and these rows say which slot ran which files.
 *
 * @param {unknown} value
 * @returns {{ files: string[], exitCode: number|null, runner: string|null, durationMs: number }[] | null}
 */
function shardRows(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256) return null;
  const rows = [];
  for (const row of value) {
    if (!Array.isArray(row?.files) || !row.files.length || row.files.length > 4096
      || row.files.some(file => !line(file, 4096) || file.startsWith('/') || file.includes('\\'))
      || row.exitCode !== null && !Number.isSafeInteger(row.exitCode) || row.runner !== null && !identity(row.runner)
      || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0) return null;
    rows.push({ files: [...row.files], exitCode: row.exitCode, runner: row.runner, durationMs: row.durationMs });
  }
  return rows;
}

/** Read explicit TAP or Node reporter totals; absent counters stay unknown rather than becoming zero. */
export function proofCounts(lines) {
  const names = { pass: 'passed', fail: 'failed', skipped: 'skipped' };
  let pending = {};
  let totals = null;
  for (const line of typeof lines === 'string' ? lines.split(/\r?\n/u) : lines) {
    const match = /^(?:#|ℹ)\s+(pass|fail|skipped)\s+(\d+)$/u.exec(line);
    if (!match) continue;
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count)) return { passed: null, failed: null, skipped: null };
    pending[names[match[1]]] = count;
    if (Object.keys(pending).length === 3) {
      totals ??= { passed: 0, failed: 0, skipped: 0 };
      for (const name of Object.values(names)) totals[name] += pending[name];
      if (!Object.values(totals).every(Number.isSafeInteger)) return { passed: null, failed: null, skipped: null };
      pending = {};
    }
  }
  return Object.keys(pending).length ? { passed: null, failed: null, skipped: null }
    : totals ?? { passed: null, failed: null, skipped: null };
}

/** Accept only measured finite milliseconds; null explicitly means the phase was not observed. */
function measured(value, nullable = false) {
  return nullable && value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/** Normalize one attempt at a named shard; concurrent attempts are retained separately, never summed as wall time. */
function shardFields(value) {
  return value && typeof value.shard === 'string' && /^[A-Za-z0-9_/-]{1,80}$/u.test(value.shard)
    && Number.isSafeInteger(value.attempt) && value.attempt > 0 && measured(value.wallMs)
    ? { shard: value.shard, attempt: value.attempt, wallMs: value.wallMs } : null;
}

/** Keep every phase explicit; missing, unsupported and legacy measurements remain unknown rather than zero. */
export function runTimingFields(value) {
  if (!value || value.version !== 1 || !(value.node === null || typeof value.node === 'string' && NODE.test(value.node))
    || !measured(value.wallMs) || !['selectionMs', 'setupMs', 'compareMs'].every(key => measured(value[key], true))
    || !(value.shards === null || Array.isArray(value.shards) && value.shards.length <= 1024)) return null;
  const shards = value.shards === null ? null : value.shards.map(shardFields);
  if (shards?.some(row => row === null)) return null;
  if (shards && new Set(shards.map(row => `${row.shard}:${row.attempt}`)).size !== shards.length) return null;
  return { version: 1, node: value.node, wallMs: value.wallMs, selectionMs: value.selectionMs,
    setupMs: value.setupMs, shards, compareMs: value.compareMs };
}
