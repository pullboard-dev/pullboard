import { environmentProblem } from '../../../config/index.js';
import { testOutcomeFields } from './test/outcomes.js';
import { sourcePreparationFields } from '../../light.js';
/**
 * What a gate run leaves for people and agents: the digest of its output and its sanitized timing profile. Trusted
 * policy checks write both, so they live apart from the gate's queue and runners, which a board read never needs [C7].
 */
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { secretsIn } from '../../../commits/index.js';

const DIGEST_CHARS = 3000;
const TAIL_CHARS = 1000;
const LINE_CHARS = 300;
const FAILURE_RE = /fail|error|expected|received|assert|not ok|✗|×|cannot|undefined|exception/i;
// A passing test's own lines, whatever its name says: TAP's `ok N` and the `# Subtest:` before it.
const PASSING_RE = /^\s*(ok \d+\b|# Subtest:)/;
// Lines kept under a failure, where test runners say why: the message, expected and actual.
const CONTEXT_LINES = 20;

/**
 * The lines of a failure worth an agent's attention: each line that looks like a failure with the
 * lines under it that say why, then the end of the output, within one cap, so a refusal or a retry
 * carries the reason and not the whole log. Passing tests are skipped however they are named. The
 * end has its own share of the cap and every line is cut short, so no single long line can push the
 * summary out. Unstructured commands keep their first diagnostic, and omitted nonempty lines are
 * counted so the excerpt never looks like the complete output.
 *
 * @param {string} output
 * @returns {string}
 */
export function digestOf(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line));
  const tail = [];
  let room = TAIL_CHARS;
  for (let at = lines.length - 1; at >= 0 && tail.length < 15 && lines[at].length < room; at -= 1) {
    tail.unshift(lines[at]);
    room -= lines[at].length + 1;
  }
  room = DIGEST_CHARS - (TAIL_CHARS - room) - 80; // Reserve the omission count inside the same cap.
  const body = lines.slice(0, lines.length - tail.length);
  const failing = [];
  for (let at = 0; at < body.length && failing.length < 40; at += 1) {
    if (PASSING_RE.test(body[at]) || !FAILURE_RE.test(body[at])) continue;
    if (/^\s*not ok \d+/u.test(body[at])) {
      let end = at + 1;
      while (end < body.length && !/^\s*(?:# Subtest:|(?:not )?ok \d+|\d+\.\.)/u.test(body[end])) end += 1;
      // Cancelled siblings are fallout; keep the actual assertion's fields inside the digest cap.
      if (body.slice(at, end).some(line => /failureType:\s*['"]testAborted['"]/u.test(line))) { at = end - 1; continue; }
    }
    const block = body.slice(at, at + CONTEXT_LINES + 1);
    const end = block.findIndex((line, n) => n > 0 && (PASSING_RE.test(line) || /^\s*(not ok \d+|\.\.\.)\s*$|^\s*not ok \d+/.test(line)));
    for (const line of end === -1 ? block : block.slice(0, end)) {
      if (line.length >= room) break;
      failing.push(line);
      room -= line.length + 1;
    }
    at += (end === -1 ? block.length : end) - 1;
  }
  if (!failing.length) {
    for (const line of body.filter(line => !PASSING_RE.test(line)).slice(0, CONTEXT_LINES + 1)) {
      if (line.length >= room) break;
      failing.push(line);
      room -= line.length + 1;
    }
  }
  const omitted = lines.length - failing.length - tail.length;
  const notice = omitted ? [`… ${omitted} nonempty output lines omitted …`] : [];
  return [...failing, ...notice, ...tail].join('\n');
}

/** Persist one sanitized timing profile as a private artifact.
 * @param {string} path
 * @param {{ files?: Array<object>, tests?: Array<object>, [key: string]: any }} profile
 * @returns {object} The sanitized profile written to disk.
 */
export function writeTimingProfile(path, profile) {
  /** Sanitize one reporter-controlled string before persistence or display.
   * @param {unknown} value
   * @param {string} label
   * @returns {unknown}
   */
  const sanitize = (value, label) => {
    if (typeof value !== 'string') return value;
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) return '[redacted profile field exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: `timing profile ${label}`, line: 1, text: value }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : value;
  };
  /** Accept only measured, nonnegative durations from reporter events. */
  const validDuration = value => Number.isFinite(value) && value >= 0;
  const files = (profile.files ?? []).filter(file => typeof file?.path === 'string' && validDuration(file.durationMs))
    .map(file => ({ path: sanitize(file.path, 'file path'), durationMs: file.durationMs }));
  const tests = (profile.tests ?? []).filter(test => (typeof test?.file === 'string' || test?.file === null) && typeof test?.name === 'string' && validDuration(test.durationMs))
    .map(test => ({ file: sanitize(test.file, 'test file'), name: sanitize(test.name, 'test name'), durationMs: test.durationMs, passed: test.passed === true }));
  const sourcePreparation = sourcePreparationFields(profile.sourcePreparation);
  const sanitized = {
    version: 1,
    waitMs: validDuration(profile.waitMs) ? profile.waitMs : 0,
    wallMs: validDuration(profile.wallMs) ? profile.wallMs : null,
    files,
    tests,
    ...(testOutcomeFields(profile.testOutcomes) ? { testOutcomes: profile.testOutcomes.map(row => ({ ...row,
      file: sanitize(row.file, 'test outcome file'), name: sanitize(row.name, 'test outcome name') })) } : {}),
    ...(profile.testCache ? { testCache: { summary: sanitize(String(profile.testCache.summary), 'test cache summary'),
      ...(profile.testCache.ledger ? { ledger: sanitize(String(profile.testCache.ledger), 'test cache ledger') } : {}),
      files: profile.testCache.files.map(row => ({ file: sanitize(row.file, 'test cache file'), outcome: row.outcome, key: row.key,
        missed: row.missed === null ? null : sanitize(String(row.missed), 'test cache missed input') })) } } : {}),
    runner: sanitize(profile.runner ?? 'shell', 'runner'),
    format: sanitize(profile.format ?? 'none', 'format'),
    unavailable: sanitize(profile.unavailable ?? null, 'availability'),
    ...(Object.hasOwn(profile, 'environment') ? { environment: environmentProblem(profile.environment) ? null : profile.environment } : {}),
    ...(profile.executionRunner ? { executionRunner: sanitize(profile.executionRunner, 'execution runner') } : {}),
    ...(sourcePreparation ? { sourcePreparation } : {}),
    ...(profile.receipt ? { receipt: { ...profile.receipt, slot: { kind: sanitize(profile.receipt.slot?.kind, 'slot kind'), reason: sanitize(profile.receipt.slot?.reason, 'slot reason') } } } : {}),
    ...(profile.landingShards ? { landingShards: {
      balance: sanitize(String(profile.landingShards.balance ?? 'unknown'), 'landing balance'),
      unverified: (profile.landingShards.unverified ?? []).map(entry => ({ shard: sanitize(String(entry.shard), 'landing unverified shard'),
        processes: sanitize(String(entry.processes), 'landing unverified processes') })),
      quarantined: (profile.landingShards.quarantined ?? []).map(entry => ({ host: sanitize(String(entry.host), 'landing quarantine host'),
        message: sanitize(String(entry.message), 'landing quarantine message') })),
      floor: profile.landingShards.floor && validDuration(profile.landingShards.floor.ms)
        ? { path: sanitize(String(profile.landingShards.floor.path), 'landing floor path'), ms: profile.landingShards.floor.ms } : null,
      // One entry per attempt, so a failed runner attempt stays beside its local rerun.
      shards: (profile.landingShards.shards ?? []).map(shard => ({ shard: sanitize(String(shard.shard), 'landing shard'),
        attempt: Number.isSafeInteger(shard.attempt) ? shard.attempt : 1,
        host: sanitize(String(shard.host), 'landing shard host'), status: sanitize(String(shard.status), 'landing shard status'),
        reason: shard.reason ? sanitize(String(shard.reason), 'landing shard reason') : null,
        wallMs: validDuration(shard.wallMs) ? shard.wallMs : null })),
      files: (profile.landingShards.files ?? []).filter(file => typeof file?.path === 'string').map(file => ({
        path: sanitize(file.path, 'landing file path'), shard: sanitize(String(file.shard), 'landing file shard'),
        host: sanitize(String(file.host), 'landing file host'), durationMs: validDuration(file.durationMs) ? file.durationMs : null })),
    } } : {}),
    ...(profile.executionSource ? { executionSource: {
      commit: sanitize(profile.executionSource.commit, 'execution commit'),
      tree: sanitize(profile.executionSource.tree, 'execution tree'),
      tooling: Object.fromEntries(Object.entries(profile.executionSource.tooling ?? {})
        .filter(([key]) => ['kind', 'name', 'version', 'commit', 'tree', 'sha256'].includes(key))
        .map(([key, value]) => [key, sanitize(value, `execution tooling ${key}`)])),
    } } : {}),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  return sanitized;
}
