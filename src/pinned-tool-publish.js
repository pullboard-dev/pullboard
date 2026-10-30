/** Promote only native full landing evidence; this module never creates or repairs proof receipts. */
import {
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tryGit } from './git.js';
import {
  readGateReceipt,
  receiptStore,
  receiptBinds,
} from './gate-run-receipt.js';
import { checkTrainLandingReceipt } from './train-landing-receipt.js';
import { policyAt } from './trusted-policy-read.js';
import {
  writeToolBuild,
  readToolBuild,
} from './pinned-tool-build.js';
import { Refused } from './refused.js';

/** Require origin-bound green full-suite evidence for an exact accepted ancestor, not a Submit/check receipt. */
export function gatedToolBuild(location, commit, receiptId, { now = Date.now() } = {}) {
  try {
    const store = receiptStore(location.root);
    const receipt = readGateReceipt(store, receiptId);
    const value = checkTrainLandingReceipt(receipt, commit);
    if (!receiptBinds(store, value) || value.full === false) throw new Error('unbound');
    const tree = tryGit(location.root, ['rev-parse', '--verify', `${commit}^{tree}`]);
    const ancestor = tryGit(location.root, ['merge-base', '--is-ancestor', commit, 'main-worktree/HEAD']);
    const command = policyAt(location.root, value.main).config.gate;
    if (tree.status !== 0 || tree.stdout.trim() !== value.tree || ancestor.status !== 0
      || !command?.trim() || createHash('sha256').update(command).digest('hex') !== value.command) throw new Error('scope');
    return { version: 1, commit, tree: value.tree, receipt: receiptId,
      promotedAt: new Date(now).toISOString(), gatedAt: value.at };
  } catch {
    throw new Refused('TOOL_BUILD_NOT_GATED', 'promote an accepted Pullboard commit with its native green full landing receipt; Submit, CHECK, collection and caller-written results cannot publish tools');
  }
}

/** Refresh to the newest eligible native full-gate receipt at a command boundary; preserve a valid prior pin. */
export function refreshToolBuild(location, { now = Date.now() } = {}) {
  const current = readToolBuild(location);
  const store = receiptStore(location.root);
  let names;
  try { names = readdirSync(store); } catch { return current; }
  // Native gate files are written once. Visit recent writes first instead of issuing Git queries
  // for every historical proof receipt on a busy board.
  const ordered = names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).map(name => {
    try { return { name, mtime: statSync(join(store, name)).mtimeMs }; } catch { return { name, mtime: 0 }; }
  }).sort((a, b) => b.mtime - a.mtime);
  for (const { name } of ordered) {
    const id = name.replace(/\.json$/u, '');
    const receipt = readGateReceipt(store, id);
    if (!receipt?.head || receipt.kind !== 'land') continue;
    try {
      const build = gatedToolBuild(location, receipt.head, id, { now });
      if (!current || Date.parse(build.gatedAt) >= Date.parse(current.gatedAt)) return writeToolBuild(location, build);
    }
    catch (error) { if (error.code !== 'TOOL_BUILD_NOT_GATED') throw error; }
  }
  return current;
}
