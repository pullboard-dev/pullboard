/** Structural release evidence only: transport authentication and native custody must be verified separately [C7,V4]. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import {
  receiptBody,
  receiptFields,
} from '../run/receipt.js';

export const RELEASE_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u;
const NONCE = /^[A-Za-z0-9_-]{1,80}$/u;

/** Recognize JSON records without inheriting fields or accepting arrays as objects. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Require exactly the declared own fields, including required fields whose value is null. */
function keys(value, expected) {
  return record(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

/** Compare normalized JSON fields without making the caller's object key order authoritative. */
function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((entry, index) => equal(entry, right[index]));
  return record(left) && record(right) && keys(left, Object.keys(right))
    && Object.keys(right).every(key => equal(left[key], right[key]));
}

/** Accept actual canonical instants, refusing invalid dates, offsets and reversed intervals. */
function instant(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && new Date(at).toISOString() === value ? at : null;
}

/** Validate a bounded list of unique executor identities, not a claimed number of machines. */
function executors(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 1024
    && value.every(id => typeof id === 'string' && LABEL.test(id)) && new Set(value).size === value.length;
}

export const RELEASE_BUDGET_SECONDS = 900;

/**
 * The release's wall time from its observed participation interval, with its 15-minute budget verdict.
 * Why: the receipt carries the measurement so a slow release is visible on the record, not only in a log.
 */
export function releaseTiming(participation, budgetSeconds = RELEASE_BUDGET_SECONDS) {
  const start = instant(participation?.startedAt), finish = instant(participation?.finishedAt);
  if (start === null || finish === null || start > finish) return null;
  const seconds = Math.ceil((finish - start) / 1000);
  return { startedAt: participation.startedAt, finishedAt: participation.finishedAt, seconds, budgetSeconds,
    status: seconds > budgetSeconds ? 'OVER_BUDGET' : 'WITHIN_BUDGET' };
}

/** Normalize observed participation once so its private native digest binds every recorded field. */
export function releaseParticipationFields(p) {
  try {
    return { version: p.version, id: p.id, head: p.head, tree: p.tree, command: p.command,
      required: [...p.required].sort(),
      shards: p.shards.map(s => ({ shard: s.shard, files: [...s.files].sort(), executor: s.executor,
        head: s.head, tree: s.tree, command: s.command, green: s.green, complete: s.complete,
        cleanupVerified: s.cleanupVerified })).sort((a, b) => a.shard < b.shard ? -1 : a.shard > b.shard ? 1 : 0),
      startedAt: p.startedAt, finishedAt: p.finishedAt };
  } catch { return null; }
}

/** Hash canonical participation only; matching bytes gain custody from the separate private gate receipt. */
export function releaseParticipationDigest(participation) {
  const fields = releaseParticipationFields(participation);
  return fields ? createHash('sha256').update(JSON.stringify(fields)).digest('hex') : null;
}

/** Check the shard partition and source bindings; the JSON itself does not prove who executed it. */
function shardProblem(participation, gate, expected) {
  const files = new Set();
  const labels = new Set();
  const participants = new Set();
  const planned = new Set(gate.collection.files);
  if (!Array.isArray(participation.shards) || !participation.shards.length || participation.shards.length > 100_000) return 'invalid shard list';
  for (const shard of participation.shards) {
    if (!keys(shard, ['shard', 'files', 'executor', 'head', 'tree', 'command', 'green', 'complete', 'cleanupVerified'])
      || typeof shard.shard !== 'string' || !LABEL.test(shard.shard) || labels.has(shard.shard)
      || !expected.required.includes(shard.executor) || shard.head !== expected.head || shard.tree !== expected.tree
      || !DIGEST.test(shard.command ?? '') || shard.green !== true || shard.complete !== true || shard.cleanupVerified !== true
      || !Array.isArray(shard.files) || !shard.files.length || shard.files.length > planned.size) return 'invalid or incomplete shard';
    labels.add(shard.shard);
    participants.add(shard.executor);
    for (const file of shard.files) {
      if (!planned.has(file) || files.has(file)) return 'shards do not partition collection files';
      files.add(file);
    }
  }
  if (files.size !== planned.size) return 'shards omit collection files';
  if (participants.size !== expected.required.length) return 'a required executor did not participate';
  return null;
}

/** Validate the complete bounded envelope without reading a file, executing a gate or writing native proof. */
function checked(envelope, expected) {
  const encoded = JSON.stringify(envelope);
  if (encoded === undefined || Buffer.byteLength(encoded) > RELEASE_RECEIPT_MAX_BYTES) return 'release receipt exceeds size bound';
  if (!keys(expected, ['head', 'tree', 'command', 'required']) || !HASH.test(expected.head ?? '')
    || !HASH.test(expected.tree ?? '') || !DIGEST.test(expected.command ?? '') || !executors(expected.required)) return 'invalid expected release binding';
  const timed = record(envelope) && Object.hasOwn(envelope, 'timing');
  if (!keys(envelope, timed ? ['version', 'gateReceipt', 'participation', 'timing'] : ['version', 'gateReceipt', 'participation'])
    || envelope.version !== 1) return 'invalid release envelope';
  const gate = receiptFields(envelope.gateReceipt);
  if (!gate || receiptBody(gate) === null || !equal(envelope.gateReceipt, gate) || gate.version !== 1 || gate.kind !== 'release'
    || gate.green !== true || gate.head !== expected.head || gate.main !== expected.head || gate.tree !== expected.tree || gate.command !== expected.command) return 'gate receipt does not match release binding';
  const collection = gate.collection;
  if (!collection || collection.full !== true || collection.complete !== true || collection.plannedFiles < 1
    || collection.completedFiles !== collection.plannedFiles || collection.completedDigest !== collection.planDigest) return 'gate collection is not full and complete';
  const p = envelope.participation;
  if (!keys(p, ['version', 'id', 'head', 'tree', 'command', 'required', 'shards', 'startedAt', 'finishedAt'])
    || p.version !== 1 || !NONCE.test(p.id ?? '') || p.id !== collection.batchId || p.head !== expected.head
    || p.tree !== expected.tree || p.command !== expected.command || !executors(p.required)
    || !equal([...p.required].sort(), [...expected.required].sort())) return 'participation does not match release binding';
  const start = instant(p.startedAt), finish = instant(p.finishedAt), at = instant(gate.at);
  if (start === null || finish === null || at === null || start > finish || at < start || at > finish) return 'invalid release receipt dates';
  if (gate.participationDigest !== releaseParticipationDigest(p)) return 'participation differs from native gate binding';
  if (timed && !equal(envelope.timing, releaseTiming(p))) return 'release timing differs from the participation interval';
  return shardProblem(p, gate, expected);
}

/** Return null for structural validity, otherwise a bounded explanation; never infer authenticated custody. */
export function releaseReceiptProblem(envelope, expected) {
  try { return checked(envelope, expected); }
  catch { return 'malformed release receipt'; }
}

/** Return deterministic structural fields only after every source, coverage and participation binding passes. */
export function releaseReceiptFields(envelope, expected) {
  if (releaseReceiptProblem(envelope, expected)) return null;
  const fields = { version: 1, gateReceipt: receiptFields(envelope.gateReceipt),
    participation: releaseParticipationFields(envelope.participation) };
  if (Object.hasOwn(envelope, 'timing')) fields.timing = releaseTiming(envelope.participation);
  return fields;
}

/** Canonical JSON bytes do not authenticate the envelope; hosted readers must verify their transport separately. */
export function releaseReceiptBody(envelope, expected) {
  const fields = releaseReceiptFields(envelope, expected);
  return fields ? JSON.stringify(fields) + '\n' : null;
}

/** Read a bounded regular local file for explicit test transport only; never import it into native proof custody. */
export function readReleaseReceipt(file, expected) {
  let fd;
  try {
    if (typeof constants.O_NOFOLLOW !== 'number') return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > RELEASE_RECEIPT_MAX_BYTES) return null;
    const bytes = Buffer.alloc(RELEASE_RECEIPT_MAX_BYTES + 1);
    let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > RELEASE_RECEIPT_MAX_BYTES) return null;
    const text = bytes.subarray(0, size).toString('utf8');
    const envelope = JSON.parse(text);
    return releaseReceiptBody(envelope, expected) === text ? releaseReceiptFields(envelope, expected) : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
