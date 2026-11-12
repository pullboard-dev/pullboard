/** Promote only native full landing evidence; this module never creates or repairs proof receipts. */
import {
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tryGit } from '../../../../../../packages/git/index.js';
import {
  readGateReceipt,
  receiptStore,
  receiptBinds,
} from '../../../../../../packages/gate/index.js';
import { checkTrainLandingReceipt } from '../../../../../../packages/landing/index.js';
import { policyAt } from '../../../../../../packages/sandbox/index.js';
import {
  writeToolBuild,
  readToolBuild,
  toolBuildPolicy,
} from './build.js';
import { Refused } from '../../../../../../packages/kernel/index.js';

/** Require origin-bound green full-suite evidence for an exact accepted ancestor, not a Submit/check receipt. */
export function gatedToolBuild(location, commit, receiptId, { now = Date.now() } = {}) {
  try {
    const store = receiptStore(location.root);
    const receipt = readGateReceipt(store, receiptId);
    const value = checkTrainLandingReceipt(receipt, commit);
    if (!receiptBinds(store, value) || value.full !== true) throw new Error('unbound or partial');
    const gatedAt = Date.parse(value.at);
    if (!Number.isFinite(gatedAt) || gatedAt > now || now - gatedAt > toolBuildPolicy(location).refreshMs) {
      throw new Refused('TOOL_BUILD_STALE', 'the full gate receipt is older than the configured refresh window; run a fresh full main gate before promotion');
    }
    const tree = tryGit(location.root, ['rev-parse', '--verify', `${commit}^{tree}`]);
    const ancestor = tryGit(location.root, ['merge-base', '--is-ancestor', commit, 'main-worktree/HEAD']);
    const command = policyAt(location.root, value.main).config.gate;
    if (tree.status !== 0 || tree.stdout.trim() !== value.tree || ancestor.status !== 0
      || !command?.trim() || createHash('sha256').update(command).digest('hex') !== value.command) throw new Error('scope');
    return { version: 1, commit, tree: value.tree, receipt: receiptId,
      promotedAt: new Date(now).toISOString(), gatedAt: value.at };
  } catch (error) {
    if (error instanceof Refused && error.code === 'TOOL_BUILD_STALE') throw error;
    throw new Refused('TOOL_BUILD_NOT_GATED', 'promote an accepted Pullboard commit with its native green full landing receipt; Submit, CHECK, collection and caller-written results cannot publish tools');
  }
}

/** Inspect all native receipts and return the newest eligible observation without publishing it. */
export function newestEligibleToolBuild(location, { now = Date.now() } = {}) {
  const store = receiptStore(location.root);
  let names;
  try { names = readdirSync(store); } catch { return null; }
  // Native gate files are written once. Visit recent writes first instead of issuing Git queries
  // for every historical proof receipt on a busy board.
  const ordered = names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).map(name => {
    try { return { name, mtime: statSync(join(store, name)).mtimeMs }; } catch { return { name, mtime: 0 }; }
  }).sort((a, b) => b.mtime - a.mtime);
  let newest = null;
  for (const { name } of ordered) {
    const id = name.replace(/\.json$/u, '');
    const receipt = readGateReceipt(store, id);
    if (!receipt?.head || receipt.kind !== 'land') continue;
    try {
      const build = gatedToolBuild(location, receipt.head, id, { now });
      if (!newest || Date.parse(build.gatedAt) > Date.parse(newest.gatedAt)) newest = build;
    }
    catch (error) { if (!['TOOL_BUILD_NOT_GATED', 'TOOL_BUILD_STALE'].includes(error.code)) throw error; }
  }
  return newest;
}

/** Refresh to the newest eligible native full-gate receipt at a command boundary; preserve a prior pin. */
export function refreshToolBuild(location, { now = Date.now() } = {}) {
  const current = readToolBuild(location);
  const newest = newestEligibleToolBuild(location, { now });
  return newest && (!current || Date.parse(newest.gatedAt) > Date.parse(current.gatedAt)) ? writeToolBuild(location, newest) : current;
}
