import { checkCommandDefinition } from './definition.js';
import { definitionUnchanged } from './definition.js';
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
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { tryGit } from '../main.js';
import { repoInfo } from '../main.js';
import { storeName } from '../store-names.js';

const fs = fileSystemAdapter();

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

/** Hash both project configuration files, including a missing-file marker. */
function projectConfig(root) {
  return Object.fromEntries(['pullboard.json', 'package.json'].map(name => {
    try { return [name, receiptDigest(fs.readFile(join(root, name), null))]; } catch (error) { return [name, error.code === 'ENOENT' ? 'missing' : 'unreadable']; }
  }));
}

/** Explain why an earlier receipt cannot even be addressed by the current inputs. */
function unavailableReceipt(root, kind, part) {
  try {
    fs.readFile(join(receiptDir(root), `${receiptDigest(kind)}-latest.json`), null);
    process.stderr.write(`${kind} receipt not reused: ${part} changed or cannot be fingerprinted\n`);
  } catch { /* First runs have no receipt to refuse. */ }
  return null;
}

/**
 * The key a check run is filed under, or null when no receipt may be read or written for it.
 *
 * @param {string} root
 * @param {{ kind: string, definition: unknown, config: unknown, code?: string[] }} check `code` names the files that run the check
 */
export function checkReceiptKey(root, { kind, definition, config, code = [], commands = typeof definition === 'string' ? [definition] : [] }) {
  const tree = cleanTree(root);
  if (!tree) return unavailableReceipt(root, kind, 'tree');
  const implementation = checkCommandDefinition(root, commands);
  if (!implementation) return unavailableReceipt(root, kind, 'check command or import closure');
  const implementationDigest = receiptDigest(implementation);
  const tool = checkCommandDefinition(root, [], code);
  if (!tool) return unavailableReceipt(root, kind, 'runner import closure');
  const checkDigest = receiptDigest({ kind, definition, tool, implementationDigest, node: process.version });
  const configDigest = receiptDigest({ effective: config ?? null, files: projectConfig(root) });
  const parts = { tree, command: receiptDigest(definition), implementation: implementationDigest, runner: receiptDigest(tool), config: configDigest };
  return { kind, tree, checkDigest, configDigest, commands, implementationDigest, parts, config, code, files: implementation, tool, key: receiptDigest({ kind, tree, checkDigest, configDigest }) };
}

/** A recorded green receipt for exactly this key, or null. */
export function readCheckReceipt(root, key) {
  if (!key) return null;
  try {
    const receipt = JSON.parse(fs.readFile(join(receiptDir(root), `${storeName(key.key)}`), 'utf8'));
    const same = receipt.version === 1 && receipt.green === true && ['kind', 'tree', 'checkDigest', 'configDigest'].every(field => receipt[field] === key[field]);
    return same ? receipt : null;
  } catch {
    try {
      const previous = JSON.parse(fs.readFile(join(receiptDir(root), `${receiptDigest(key.kind)}-latest.json`), 'utf8'));
      const changed = Object.keys(key.parts).filter(part => previous.parts?.[part] !== key.parts[part]);
      const paths = key.files.filter(file => previous.files?.find(old => old.path === file.path)?.digest !== file.digest).map(file => file.path);
      if (paths.length) changed.push(`checker files (${paths.join(', ')})`);
      if (changed.length) process.stderr.write(`${key.kind} receipt not reused: ${changed.map(part => `${part} changed`).join('; ')}\n`);
    } catch { /* A first run has no prior definition to compare. */ }
    return null;
  }
}

/** Record a green run under its key; a failed write only means the next caller runs the check again. */
export function writeCheckReceipt(root, key, { by = '', result = null } = {}) {
  if (!key || cleanTree(root) !== key.tree || !definitionUnchanged(root, key.files, key.commands ?? [], []) || !definitionUnchanged(root, key.tool, [], key.code) || receiptDigest({ effective: key.config ?? null, files: projectConfig(root) }) !== key.configDigest) return null;
  const receipt = { version: 1, id: randomUUID(), kind: key.kind, tree: key.tree, checkDigest: key.checkDigest, configDigest: key.configDigest,
    parts: key.parts, files: key.files, green: true, by, at: new Date().toISOString(), result };
  try {
    const dir = receiptDir(root);
    fs.mkdir(dir, { recursive: true });
    const temporary = join(dir, `.${receipt.id}.tmp`);
    fs.writeFile(temporary, `${JSON.stringify(receipt)}\n`);
    fs.rename(temporary, join(dir, `${storeName(key.key)}`));
    fs.writeFile(temporary, `${JSON.stringify(receipt)}\n`);
    fs.rename(temporary, join(dir, `${receiptDigest(key.kind)}-latest.json`));
  } catch (error) { process.stderr.write(`check receipt not recorded for ${key.kind} at tree ${key.tree.slice(0, 12)}: ${error.message}\n`); }
  return receipt;
}

/** One line citing a reused receipt. */
export function receiptLine(receipt) {
  return `${receipt.kind} check reused receipt ${receipt.id} for tree ${receipt.tree.slice(0, 12)} (recorded by ${receipt.by || 'an earlier run'} at ${receipt.at}); not run again`;
}
