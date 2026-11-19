/** Complete accepted-tree cell inventories, produced off the submit path [C7]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { join } from 'node:path';
import {
  serialize,
  deserialize,
} from 'node:v8';
import {
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import {
  git,
  gitChildEnv,
} from '../../../git/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';
import {
  cellInventory,
  updateCellInventory,
  needsFullCensus,
} from './cell/lint/inventory.js';
import {
  cellLintReport,
  CELL_METRICS,
} from './cell/lints.js';
import { withCellLintParser } from './cell/parser.js';
import { withBindingReadCache } from './cell/uses.js';

const fs = fileSystemAdapter();

const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED = 256 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const TREE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Hash bytes to bind both the identity and the completed artifact. */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Validate the caller's trusted checker and preload fingerprints and bind the actual Node version. */
function identity({ tree, checker, preloads }) {
  if (!TREE.test(tree ?? '') || !HASH.test(checker ?? '') || !HASH.test(preloads ?? '')) throw new TypeError('accepted inventory needs a tree and trusted checker and preload SHA-256 fingerprints');
  return { tree, checker, preloads, node: process.version };
}

/** Identify trusted binding observations independently of tree and machine paths. */
export function acceptedInventoryRuntimeIdentity({ checker, preloads }) {
  if (!HASH.test(checker ?? '') || !HASH.test(preloads ?? '')) throw new TypeError('accepted inventory needs trusted fingerprints');
  return digest(JSON.stringify({ checker, preloads, node: process.version }));
}

/** Stable tree-keyed name; equal trees and checker environments share an artifact across commits. */
export function acceptedInventoryKey(options) { return digest(JSON.stringify(identity(options))); }

/** Locate the machine cache entry without making a missing entry look like a completed artifact. */
function artifactFile(directory, key) { return join(directory, `${key}.inventory.gz`); }

/** Reject malformed inventories rather than promoting missing graph data to proof. */
function validInventory(value) {
  return value && value.files instanceof Map && value.edges instanceof Map && Array.isArray(value.unknown)
    && [...value.files].every(([path, bytes]) => typeof path === 'string' && Buffer.isBuffer(bytes))
    && [...value.edges].every(([path, rows]) => typeof path === 'string' && Array.isArray(rows)
      && rows.every(row => row && typeof row === 'object' && typeof row.target === 'string'))
    && value.unknown.every(row => row && typeof row.file === 'string' && typeof row.reason === 'string');
}

/** Validate cached report structure; its observation time remains visible to time-sensitive consumers. */
function validReport(report) {
  return report?.version === 1 && report.metrics && CELL_METRICS.every(name => {
    const metric = report.metrics[name];
    return metric && Number.isSafeInteger(metric.count) && metric.count >= 0 && Array.isArray(metric.findings)
      && metric.findings.every(row => row && typeof row.key === 'string' && Number.isSafeInteger(row.count));
  }) && Array.isArray(report.unknown) && Array.isArray(report.roots);
}

/** Validate bounded transport bytes against an independently trusted descriptor before exposing inventory. */
export function validateAcceptedInventory(bytes, descriptor) {
  try {
    const expected = identity(descriptor ?? {});
    if (descriptor.node !== expected.node || !HASH.test(descriptor.digest ?? '') || !Buffer.isBuffer(bytes)
      || !bytes.length || bytes.length > MAX_COMPRESSED || digest(bytes) !== descriptor.digest) throw new Error('identity or digest mismatch');
    const raw = gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED });
    const envelope = deserialize(raw);
    if (envelope?.version !== 1 || !Buffer.isBuffer(envelope.payload) || !HASH.test(envelope.digest ?? '')
      || digest(envelope.payload) !== envelope.digest) throw new Error('invalid payload digest');
    const artifact = deserialize(envelope.payload);
    if (artifact?.version !== 1 || JSON.stringify(artifact.identity) !== JSON.stringify(expected)
      || !Number.isSafeInteger(artifact.observedAt) || artifact.observedAt < 0
      || !validInventory(artifact.inventory) || !validReport(artifact.report) || !(artifact.observations instanceof Map)
      || artifact.observations.size > 32768 || [...artifact.observations].some(([key, row]) => typeof key !== 'string'
        || !row || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
      || [...artifact.observations.values()].reduce((sum, row) => sum + row.bytes, 0) > 128 * 1024 * 1024) throw new Error('invalid artifact');
    return { available: true, descriptor: { ...expected, digest: descriptor.digest }, bytes, inventory: artifact.inventory,
      report: artifact.report, observations: artifact.observations, runtimeIdentity: acceptedInventoryRuntimeIdentity(expected), observedAt: artifact.observedAt };
  } catch { return { available: false, cause: 'invalid-artifact' }; }
}

/** Read one completed machine artifact; cold and damaged caches never trigger a census. */
export function readAcceptedInventory({ directory, ...options }) {
  const expected = identity(options), file = artifactFile(directory, acceptedInventoryKey(expected));
  try {
    const fd = fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstat(fd);
      if (!stat.isFile() || stat.size > MAX_COMPRESSED || stat.size < 1) return { available: false, cause: 'invalid-artifact' };
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.read(fd, bytes, offset, bytes.length - offset, null);
        if (!count) return { available: false, cause: 'invalid-artifact' };
        offset += count;
      }
      if (fs.read(fd, Buffer.alloc(1), 0, 1, null)) return { available: false, cause: 'invalid-artifact' };
      const result = validateAcceptedInventory(bytes, { ...expected, digest: digest(bytes) });
      return result.available ? { ...result, file } : result;
    } finally { fs.close(fd); }
  } catch (error) {
    return { available: false, cause: error.code === 'ENOENT' ? 'missing-artifact' : 'unreadable-artifact' };
  }
}

/** Assert the pinned checkout is clean and still points at the requested commit and actual Git tree. */
function checkedTree(root, commit) {
  const env = gitChildEnv(root);
  if (!TREE.test(commit ?? '') || git(root, ['rev-parse', 'HEAD'], { env }).trim() !== commit
    || git(root, ['status', '--porcelain', '--untracked-files=all'], { env })) throw new Error('accepted inventory requires a clean pinned checkout');
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'], { env }).trim();
  if (!TREE.test(tree)) throw new Error('accepted inventory requires a Git tree');
  return tree;
}

/** Build and atomically publish a complete inventory off-path, once per key under the caller's durable lock. */
export async function warmAcceptedInventory({ directory, root, commit, checker, preloads, parsers, withLock, withImportParseCache, eligible, prior, onMode = () => {} }) {
  if (typeof directory !== 'string' || !directory || typeof root !== 'string' || typeof withLock !== 'function'
    || typeof parsers?.importsIn !== 'function' || typeof parsers?.commonJsIn !== 'function'
    || typeof withImportParseCache !== 'function' || typeof eligible !== 'function' || !eligible()) throw new TypeError('accepted inventory needs a cache directory, checkout, parser ports and lock');
  const tree = checkedTree(root, commit), options = { tree, checker, preloads };
  const expected = identity(options), key = acceptedInventoryKey(expected);
  return withLock(join(directory, `${key}.lock.sqlite`), async () => {
    if (checkedTree(root, commit) !== tree) throw new Error('accepted inventory tree changed');
    const cached = readAcceptedInventory({ directory, ...expected });
    if (cached.available) return { ...cached, reused: true };
    let previous = null, changed = null;
    if (prior?.artifact?.available && TREE.test(prior.commit ?? '')) {
      try {
        const actualTree = git(root, ['rev-parse', `${prior.commit}^{tree}`], { env: gitChildEnv(root) }).trim();
        const descriptor = prior.artifact.descriptor;
        const validated = validateAcceptedInventory(prior.artifact.bytes, descriptor);
        if (validated.available && actualTree === descriptor.tree && descriptor.checker === checker
          && descriptor.preloads === preloads && descriptor.node === process.version) {
          changed = git(root, ['diff', '--name-only', '--no-renames', '-z', prior.commit, commit], { env: gitChildEnv(root) }).split('\0').filter(Boolean);
          if (!needsFullCensus(changed)) previous = validated;
        }
      } catch { /* Unknown ancestry or invalid evidence requires an off-path full census. */ }
    }
    onMode(previous ? 'incremental-ancestor' : changed ? 'full-global-input-change' : 'full-no-compatible-ancestor');
    const observations = previous ? new Map(previous.observations) : new Map();
    const { inventory, report } = withImportParseCache(() => withBindingReadCache(() => withCellLintParser(() => {
      const inventory = previous ? updateCellInventory(root, parsers, previous.inventory, changed) : cellInventory(root, parsers);
      return { inventory, report: cellLintReport(root, parsers, { inventory }) };
    }), { eligible, observations, warmAll: true, runtimeIdentity: acceptedInventoryRuntimeIdentity(expected) }));
    if (!eligible()) throw new Error('accepted inventory runtime changed during census');
    if (checkedTree(root, commit) !== tree) throw new Error('accepted inventory tree changed during census');
    const observedAt = Date.now();
    const payload = serialize({ version: 1, identity: expected, observedAt, inventory, report, observations });
    const raw = serialize({ version: 1, digest: digest(payload), payload });
    if (raw.length > MAX_UNCOMPRESSED) throw new Error('accepted inventory exceeds the uncompressed limit');
    const bytes = gzipSync(raw);
    if (bytes.length > MAX_COMPRESSED) throw new Error('accepted inventory exceeds the transport limit');
    const descriptor = { ...expected, digest: digest(bytes) };
    const checked = validateAcceptedInventory(bytes, descriptor);
    if (!checked.available) throw new Error('accepted inventory failed validation');
    fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      fs.rename(temporary, artifactFile(directory, key));
    } finally { fs.rm(temporary, { force: true }); }
    return { ...checked, file: artifactFile(directory, key), reused: false };
  });
}
