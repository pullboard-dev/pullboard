import { createHash } from 'node:crypto';
import { boardReceiptStore } from './gate-run-receipt.js';
import { readGateReceipt } from './gate-run-receipt.js';
import { frozenCheck } from './trusted-policy.js';
import { mappedCheck } from './path-map.js';
/** Claimed companions bind their original author source to actual native composed proof [C7,V4,H16]. */
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitSpawnSync } from './git-adapter.js';
import { cleanGitEnvironment } from './git.js';
import { repoInfo } from './git.js';
import { itemPatches } from './item-patch-state.js';
import { itemPatchDigest } from './item-patch-state.js';
import { composeItemPatches } from './item-patch-compose.js';
import { validateItemPatchInput } from './item-patch-review.js';
import { itemPolicy } from './trusted-policy.js';
import { getItem } from './board-query.js';
import { proofReceipts } from './board-query.js';
import { ITEM_PATCH_SUBMIT_ENGINE } from './item-patch-submit-engine.js';
import { Refused } from './refused.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Use the accepted Git adapter, preserving ordinary hooks for private worktree creation/removal. */
function git(root, args) {
  const result = gitSpawnSync(args, { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('ITEM_PATCH', `companion source Git ${args[0]} failed: ${String(result.stderr ?? '').slice(0, 1000)}`);
  return result.stdout.trim();
}

/** Compose exactly the builder head without moving it or lending the builder another lane. */
export function prepareItemPatchSubmit(root, board, item, source) {
  const patches = itemPatches(board, item.item_id);
  if (!patches.length) return null;
  for (const patch of patches) {
    if (patch.commit !== source || patch.source?.commit !== source) {
      throw new Refused('ITEM_PATCH_SOURCE', `stale companion ${patch.key} belongs to ${patch.commit}; remove it and attach against current builder head ${source}`);
    }
    validateItemPatchInput(board, itemPolicy(root, item).config, patch.author.agentId, patch.patch);
  }
  const digest = itemPatchDigest(board, item.item_id, source);
  const composed = composeItemPatches(root, { ...item, item_commit: source }, patches);
  if (composed.digest !== digest) throw new Refused('ITEM_PATCH_CHANGED', 'read the current companion set and restart submit');
  return { version: 1, source, sourceTree: git(root, ['rev-parse', `${source}^{tree}`]),
    commit: composed.commit, tree: git(root, ['rev-parse', `${composed.commit}^{tree}`]), digest };
}

/** Validate replayable source identity and require the exact native proof rows already recorded on this item. */
export function checkItemPatchSubmit(board, id, options) {
  const binding = options.companion;
  if (!binding) return null;
  const item = getItem(board, id);
  const keys = ['version', 'source', 'sourceTree', 'commit', 'tree', 'digest', 'receiptIds'];
  if (board.executionEngineVersion !== undefined && board.executionEngineVersion < ITEM_PATCH_SUBMIT_ENGINE
    || !binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).sort().join(',') !== [...keys].sort().join(',') || binding.version !== 1
    || !['source', 'sourceTree', 'commit', 'tree'].every(key => SHA.test(binding[key] ?? ''))
    || binding.source !== options.commit || binding.sourceTree !== options.tree
    || !/^[a-f0-9]{64}$/u.test(binding.digest ?? '')
    || binding.digest !== itemPatchDigest(board, id, binding.source)
    || !itemPatches(board, id).length || itemPatches(board, id).some(patch => patch.commit !== binding.source || patch.source?.commit !== binding.source)
    || !Array.isArray(binding.receiptIds) || binding.receiptIds.length < 1 || binding.receiptIds.length > 2
    || new Set(binding.receiptIds).size !== binding.receiptIds.length) {
    throw new Refused('ITEM_PATCH_CHANGED', 'the source or companion set changed; compose and prove the current exact inputs before submitting');
  }
  const receipts = proofReceipts(board, id);
  for (const receiptId of binding.receiptIds) {
    const receipt = receipts.find(row => row.id === receiptId);
    if (!receipt || receipt.kind !== 'submit' || receipt.commit !== binding.commit || receipt.tree !== binding.tree
      || receipt.seat !== options.agentId || receipt.frozenDigest !== item.item_frozen_digest || receipt.sourceClean !== true
      || !Number.isSafeInteger(receipt.exitCode) || options.gateGreen === true && receipt.exitCode !== 0) {
      throw new Refused('ITEM_PATCH_CHANGED', 'the composed source needs its own recorded green native submit receipts');
    }
  }
  return binding;
}

/** Bind origin composition to this board's actual registered builder worktree, never a supplied repository path. */
export function sealItemPatchSubmit(board, id, options) {
  const patches = itemPatches(board, id);
  if (!patches.length && !options.companion) return options;
  const binding = checkItemPatchSubmit(board, id, options);
  if (!binding) throw new Refused('ITEM_PATCH_CHANGED', 'submit must prove the attached companions on their exact composed source');
  const item = getItem(board, id);
  const root = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(options.agentId)?.agent_path;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  try {
    if (!root || !file || realpathSync(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) !== realpathSync(file)) throw new Error('foreign board');
    if (git(root, ['rev-parse', 'HEAD']) !== options.commit) throw new Error('builder moved');
    const receipts = binding.receiptIds.map(id => readGateReceipt(boardReceiptStore(board), id));
    if (receipts.some(receipt => !receipt || receipt.version !== 2 || receipt.kind !== 'submit'
      || receipt.head !== binding.commit || receipt.tree !== binding.tree || receipt.main !== options.policyCommit
      || options.gateGreen === true && !receipt.green
      || receipt.proof.seat !== options.agentId || receipt.proof.item !== id
      || receipt.proof.frozenDigest !== item.item_frozen_digest || !receipt.proof.sourceClean)) throw new Error('unbound native proof');
    const criterion = mappedCheck(root, frozenCheck(item), { commit: binding.commit });
    if (criterion && (!receipts[0]?.green || receipts[0]?.command !== createHash('sha256').update(criterion).digest('hex'))) throw new Error('different frozen command');
    const expected = prepareItemPatchSubmit(root, board, item, options.commit);
    const { receiptIds, ...source } = binding;
    if (JSON.stringify(source) !== JSON.stringify(expected)) throw new Error('changed composition');
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('ITEM_PATCH_CHANGED', 'the submitted companion source no longer matches this board and its exact deterministic composition');
  }
  return options;
}

/** Execute in a native temporary worktree sharing the real receipt store; always remove only this owned scratch. */
export async function withItemPatchSubmit(root, binding, work) {
  if (!binding) return work(root);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-companion-submit-'));
  const checkout = join(directory, 'repo');
  let added = false;
  try {
    git(root, ['worktree', 'add', '--detach', checkout, binding.commit]);
    added = true;
    return await work(checkout);
  } finally {
    try { if (added) { git(root, ['worktree', 'remove', '--force', checkout]); added = false; } }
    finally { if (!added) rmSync(directory, { recursive: true, force: true }); }
  }
}
