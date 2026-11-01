/**
 * Each check runs once per tree (#2230). A static, lint or doctrine check that passed records a receipt keyed by the
 * exact git tree it read, a digest of the check's own definition (its command, the rules it holds and the code that
 * runs it) and a digest of the effective config. Submit, review and landing read a matching receipt instead of running
 * the check again, and run it only when the tree, the check or the config changed. Receipts live in the shared git
 * directory, so every worktree of one repository reads the same ones; only green results are kept, and a checkout with
 * uncommitted or untracked files never reads or writes one, since its tree hash does not describe what the check read.
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from './git.js';
import { repoInfo } from './git.js';

/** Stable JSON: object keys sorted at every depth, so equal values always hash the same. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** SHA-256 of a stable value. */
export function receiptDigest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

/** The clean tree a check reads, or null when the checkout holds changes its tree hash does not describe. */
export function cleanTree(root) {
  const status = tryGit(root, ['status', '--porcelain', '--untracked-files=all']);
  const tree = tryGit(root, ['rev-parse', 'HEAD^{tree}']);
  if (status.status !== 0 || tree.status !== 0 || status.stdout.trim()) return null;
  return tree.stdout.trim();
}

/** The receipt folder in the repository's shared git directory. */
function receiptDir(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'check-receipts');
}

/**
 * The key a check run is filed under, or null when no receipt may be read or written for it.
 *
 * @param {string} root
 * @param {{ kind: string, definition: unknown, config: unknown, code?: string[] }} check `code` names the files that run the check
 */
export function checkReceiptKey(root, { kind, definition, config, code = [] }) {
  const tree = cleanTree(root);
  if (!tree) return null;
  const tool = code.map(file => { try { return receiptDigest(readFileSync(file, 'utf8')); } catch { return 'missing'; } });
  const checkDigest = receiptDigest({ kind, definition, tool, node: process.version });
  const configDigest = receiptDigest(config ?? null);
  return { kind, tree, checkDigest, configDigest, key: receiptDigest({ kind, tree, checkDigest, configDigest }) };
}

/** A recorded green receipt for exactly this key, or null. */
export function readCheckReceipt(root, key) {
  if (!key) return null;
  try {
    const receipt = JSON.parse(readFileSync(join(receiptDir(root), `${key.key}.json`), 'utf8'));
    const same = receipt.version === 1 && receipt.green === true && ['kind', 'tree', 'checkDigest', 'configDigest'].every(field => receipt[field] === key[field]);
    return same ? receipt : null;
  } catch { return null; /* No receipt, or an unreadable one: the check runs. */ }
}

/** Record a green run under its key; a failed write only means the next caller runs the check again. */
export function writeCheckReceipt(root, key, { by = '', result = null } = {}) {
  if (!key || cleanTree(root) !== key.tree) return null;
  const receipt = { version: 1, id: randomUUID(), kind: key.kind, tree: key.tree, checkDigest: key.checkDigest, configDigest: key.configDigest,
    green: true, by, at: new Date().toISOString(), result };
  try {
    const dir = receiptDir(root);
    mkdirSync(dir, { recursive: true });
    const temporary = join(dir, `.${receipt.id}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`);
    renameSync(temporary, join(dir, `${key.key}.json`));
  } catch (error) { process.stderr.write(`check receipt not recorded for ${key.kind} at tree ${key.tree.slice(0, 12)}: ${error.message}\n`); }
  return receipt;
}

/** One line citing a reused receipt. */
export function receiptLine(receipt) {
  return `${receipt.kind} check reused receipt ${receipt.id} for tree ${receipt.tree.slice(0, 12)} (recorded by ${receipt.by || 'an earlier run'} at ${receipt.at}); not run again`;
}
