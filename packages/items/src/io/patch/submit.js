import { createHash } from 'node:crypto';
/** Claimed companions bind their original author source to actual native composed proof [C7,V4,H16]. */
import { rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gitSpawnSync } from "../../../../git/index.js";
import { cleanGitEnvironment } from "../../../../git/index.js";
import { repoInfo } from "../../../../git/index.js";
import { itemPatches } from "./state.js";
import { itemPatchDigest } from "./state.js";
import { composeItemPatches } from "./compose.js";
import { validateItemPatchInput } from "./review.js";
import { ITEM_PATCH_SUBMIT_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/index.js";
import { claimedItemRoot } from '../claim.js';
import { headCommitOf } from '../submit/revs.js';
import { scratchFolder } from '../../../../config/index.js';

/** The claimed item's validated checkout, offered to the engine ports through the items front door [C7]. */
export { claimedItemRoot };

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
  const { itemPolicy } = board.enginePorts.sandboxPolicyReads;
  const policy = itemPolicy(root, item);
  for (const patch of patches) {
    if (patch.commit !== source || patch.source?.commit !== source) {
      throw new Refused('ITEM_PATCH_SOURCE', `stale companion ${patch.key} belongs to ${patch.commit}; remove it and attach against current builder head ${source}`);
    }
    validateItemPatchInput(board, policy.config, patch.author.agentId, patch.patch, policy.commit);
  }
  const digest = itemPatchDigest(board, item.item_id, source);
  const composed = composeItemPatches(root, { ...item, item_commit: source }, patches);
  if (composed.digest !== digest) throw new Refused('ITEM_PATCH_CHANGED', 'read the current companion set and restart submit');
  return { version: 1, source, sourceTree: git(root, ['rev-parse', `${source}^{tree}`]),
    commit: composed.commit, tree: git(root, ['rev-parse', `${composed.commit}^{tree}`]), digest };
}

/** Seal applicability at the registered origin; replay receives values and never probes local Git. */
export function sealItemPatchFollow(board, id, options) {
  const item = board.nativePorts.getItem(board, id);
  if (item.item_status !== 'claimed' || item.item_owner !== options?.agentId
    || !(item.item_lease_until > board.clock.now().toISOString())) {
    throw new Refused('NOT_YOURS', 'claim this item before following its companions');
  }
  const root = claimedItemRoot(board, item);
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!SHA.test(options.commit ?? '') || !root || !file
    || realpathSync(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) !== realpathSync(file)
    || headCommitOf(root) !== options.commit || git(root, ['status', '--porcelain'])) {
    throw new Refused('ITEM_PATCH_SOURCE', 'follow companions only on the clean registered builder head of this board');
  }
  const patches = itemPatches(board, id);
  if (!patches.length) throw new Refused('NO_ITEM_PATCH', 'list the current item patches and select an existing key');
  const { itemPolicy } = board.enginePorts.sandboxPolicyReads;
  const policy = itemPolicy(root, item);
  for (const patch of patches) {
    if (patch.source?.commit !== patch.commit) throw new Refused('ITEM_PATCH_CHANGED', 'restore the exact companion source binding before following it');
    git(root, ['merge-base', '--is-ancestor', patch.commit, options.commit]);
    validateItemPatchInput(board, policy.config, patch.author.agentId, patch.patch, policy.commit);
  }
  // Each companion keeps the head it was written against, so a moved head composes three-way from there (#2625).
  const rebound = patches.map(patch => ({ ...patch, origin: patch.attachedCommit ?? patch.commit, commit: options.commit, source: { commit: options.commit } }));
  const composed = composeItemPatches(root, { ...item, item_commit: options.commit }, rebound);
  return { agentId: options.agentId, commit: options.commit, digest: itemPatchDigest(board, id),
    previous: patches.map(({ key, commit, digest }) => ({ key, commit, digest })), nextDigest: composed.digest };
}

/** Validate replayable source identity and require the exact native proof rows already recorded on this item. */
export function checkItemPatchSubmit(board, id, options) {
  const binding = options.companion;
  if (!binding) return null;
  const item = board.nativePorts.getItem(board, id);
  const keys = ['version', 'source', 'sourceTree', 'commit', 'tree', 'digest', 'receiptIds', 'phases'];
  if (board.executionEngineVersion !== undefined && board.executionEngineVersion < ITEM_PATCH_SUBMIT_ENGINE
    || !binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).sort().join(',') !== [...keys].sort().join(',') || binding.version !== 1
    || !['source', 'sourceTree', 'commit', 'tree'].every(key => SHA.test(binding[key] ?? ''))
    || binding.source !== options.commit || binding.sourceTree !== options.tree
    || !/^[a-f0-9]{64}$/u.test(binding.digest ?? '')
    || binding.digest !== itemPatchDigest(board, id, binding.source)
    || !itemPatches(board, id).length || itemPatches(board, id).some(patch => patch.commit !== binding.source || patch.source?.commit !== binding.source)
    || !Array.isArray(binding.receiptIds) || binding.receiptIds.length > 2
    || new Set(binding.receiptIds).size !== binding.receiptIds.length
    || !Array.isArray(binding.phases) || binding.phases.length !== binding.receiptIds.length
    || binding.phases.some(phase => !phase || Object.keys(phase).sort().join(',') !== 'command,role'
      || !['criterion', 'proof'].includes(phase.role) || !/^[a-f0-9]{64}$/u.test(phase.command ?? ''))
    || new Set(binding.phases.map(phase => phase.role)).size !== binding.phases.length) {
    throw new Refused('ITEM_PATCH_CHANGED', 'the source or companion set changed; compose and prove the current exact inputs before submitting');
  }
  const { nativeProofBlockingGreen } = board.nativePorts.patchProof;
  const receipts = board.nativePorts.proofReceipts(board, id);
  for (const [index, receiptId] of binding.receiptIds.entries()) {
    const receipt = receipts.find(row => row.id === receiptId);
    const phase = binding.phases[index];
    if (!receipt || receipt.kind !== 'submit' || receipt.commit !== binding.commit || receipt.tree !== binding.tree
      || receipt.submitPhase !== phase.role || receipt.command !== phase.command
      || receipt.seat !== options.agentId || receipt.frozenDigest !== item.item_frozen_digest || receipt.sourceClean !== true
      || !Number.isSafeInteger(receipt.exitCode) || options.gateGreen === true && !nativeProofBlockingGreen(receipt)) {
      throw new Refused('ITEM_PATCH_CHANGED', 'the composed source needs its own recorded green native submit receipts');
    }
    if (Object.hasOwn(receipt, 'blockingVerdict')) board.nativePorts.quarantine.validateQuarantineVerdict(board, {
      green: receipt.exitCode === 0, failures: receipt.failures, blockingVerdict: receipt.blockingVerdict });
  }
  return binding;
}

/** Bind origin composition to this board's actual registered builder worktree, never a supplied repository path. */
export function sealItemPatchSubmit(board, id, options) {
  const patches = itemPatches(board, id);
  if (!patches.length && !options.companion) return options;
  const { boardReceiptStore, readGateReceipt, receiptBlockingGreen, submitGateConfig, submitGatePlan } = board.nativePorts.patchProof;
  const binding = checkItemPatchSubmit(board, id, options);
  if (!binding) throw new Refused('ITEM_PATCH_CHANGED', 'submit must prove the attached companions on their exact composed source');
  const item = board.nativePorts.getItem(board, id);
  const root = board.enginePorts?.submitHandoffBoardRoot?.(board, id, options.agentId)
    ?? (item.item_status === 'claimed' ? claimedItemRoot(board, item)
      : board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(options.agentId)?.agent_path);
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  try {
    if (!root || !file || realpathSync(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) !== realpathSync(file)) throw new Error('foreign board');
    // A pulled gate applies its receipt after the builder has moved on; its binding and receipts already name the exact source [P7,C7,#8747].
    if (!options.pulledPlan && headCommitOf(root) !== options.commit) throw new Error('builder moved');
    const receipts = binding.receiptIds.map(id => readGateReceipt(boardReceiptStore(board), id));
    if (receipts.some(receipt => !receipt || receipt.version !== 2 || receipt.kind !== 'submit'
      || receipt.head !== binding.commit || receipt.tree !== binding.tree || receipt.main !== options.policyCommit
      || options.gateGreen === true && !receiptBlockingGreen(receipt)
      || receipt.proof.seat !== options.agentId || receipt.proof.item !== id
      || receipt.proof.frozenDigest !== item.item_frozen_digest || !receipt.proof.sourceClean)) throw new Error('unbound native proof');
    for (const receipt of receipts) board.nativePorts.quarantine.sealQuarantineVerdict(board, receipt);
    const { policyAt, frozenCheck } = board.enginePorts.sandboxPolicyReads;
    // A pulled gate's plan is the one main's tooling made on the runner, read from the receipt the board recorded;
    // re-planning here with this host's tooling would judge another plan than the one that ran [P7].
    const pulled = options.pulledPlan ?? null;
    const plan = pulled ? { check: frozenCheck(item), proofFiles: pulled.proofFiles, selection: { full: pulled.full === true, files: pulled.deferredFiles ?? [] }, deferred: pulled.deferred === true, deferSelection: Array.isArray(pulled.deferredFiles) }
      : submitGatePlan(root, submitGateConfig(policyAt(root, binding.commit).config, policyAt(root, options.policyCommit).config),
        { base: item.item_claim_head, trunk: options.policyCommit, check: frozenCheck(item), commit: binding.commit });
    const phases = pulled ? pulled.phases.map(({ role, command }) => ({ role, command }))
      : plan.phases.map(({ role, command }) => ({ role, command: createHash('sha256').update(command).digest('hex') }));
    if (pulled && Boolean(plan.check) !== (phases[0]?.role === 'criterion')) throw new Error('missing or substituted required phase');
    if (JSON.stringify(binding.phases) !== JSON.stringify(phases)
      || receipts.some((receipt, index) => receipt.proof.submitPhase !== phases[index]?.role || receipt.command !== phases[index]?.command)
      || plan.check && !receiptBlockingGreen(receipts[0])) throw new Error('missing or substituted required phase');
    const summary = options.submissionProof;
    if (!summary || JSON.stringify(summary.files) !== JSON.stringify(plan.proofFiles) || summary.full !== plan.selection.full
      || summary.deferred !== plan.deferred || JSON.stringify(summary.deferredFiles ?? []) !== JSON.stringify(plan.deferSelection ? plan.selection.files : [])) {
      throw new Error('different required selection');
    }
    const expected = prepareItemPatchSubmit(root, board, item, options.commit);
    const { receiptIds, phases: _phases, ...source } = binding;
    if (JSON.stringify(source) !== JSON.stringify(expected)) throw new Error('changed composition');
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('ITEM_PATCH_CHANGED', 'the submitted companion source no longer matches this board and its exact deterministic composition');
  }
  return options;
}

/** Execute in a native temporary worktree sharing the real receipt store; always remove only this owned scratch, after any diagnostics the work left running. */
export async function withItemPatchSubmit(root, binding, work) {
  if (!binding) return work(root);
  const directory = realpathSync(scratchFolder('pullboard-companion-submit-'));
  const checkout = join(directory, 'repo');
  try {
    git(root, ['worktree', 'add', '--detach', checkout, binding.commit]);
    const result = await work(checkout);
    // A red gate's flake diagnostics run after its verdict and still ask for a slot and a checkout under this root: keep the scratch until they settle.
    await result?.diagnosing?.catch?.(() => {});
    return result;
  } finally {
    // A post-checkout hook may fail after Git registered the worktree: inspect native registration, not exit status.
    const registered = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`worktree ${checkout}`);
    if (registered) git(root, ['worktree', 'remove', '--force', checkout]);
    rmSync(directory, { recursive: true, force: true });
  }
}
