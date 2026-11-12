import {
  receiptBlockingGreen,
} from '../../../../../verify/index.js';
import {
  effectiveItemHead,
} from '../../../../../verify/index.js';
import {
  itemPolicy,
} from '../../trusted/policy.js';
import {
  requireTrunkMerge,
} from '../../trusted/policy.js';
import {
  retryReviewCommit,
} from '../../../../../verify/index.js';
import {
  getItem,
} from '../../../../../store/index.js';
/** Seal only gate-owned receipts on a composition produced by the trusted worker [C7,V4,H16]. */
import {
  sourceAdvanceReviewEpisode,
} from '../../../../../verify/index.js';
import {
  realpathSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  repoInfo,
} from '../../../../../git/index.js';
import {
  sourceConflictFiles,
} from '../../../../../merge/index.js';
import {
  itemById,
} from '../../../../../store/index.js';
import {
  sourceAdvanceCASProblem,
} from '../advance.js';
import {
  prepareItemPatchReview,
} from '../../../../../items/index.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  preparedSourceComposition,
} from '../../../../../merge/index.js';
import {
  sourceAdvancePlan,
} from '../../../../../codemap/index.js';
import {
  sourceAdvanceHash,
} from '../../../../../codemap/index.js';
import {
  sourceAdvanceEpisode,
} from '../../../../../verify/index.js';
import {
  sourceAdvanceChain,
} from '../../../../../verify/index.js';
import {
  sourceAdvanceVerdict,
} from '../advance.js';
import {
  itemPatchDigest,
} from '../../../../../items/index.js';
import {
  mainPolicy,
} from '../../trusted/policy/committed.js';
import {
  frozenCheck,
} from '../../trusted/policy.js';
import {
  git,
} from '../../../../../git/index.js';
import {
  Refused,
} from '../../../../../kernel/index.js';
import {
  outsideSource,
} from '../../../../../items/index.js';

const PREPARED = new Map();
const BASES = new WeakSet();

/** Bind origin capability to the actual native board, not an agent-provided repository. */
function identity(board) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value ?? null;
}

/** Origin authority belongs to this physical native board and its current registered main checkout. */
function requireNativeRoot(board, root) {
  const registered = board.db.prepare("SELECT agent_path FROM agent WHERE agent_id='coordinator'").get()?.agent_path;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  try {
    const info = repoInfo(root);
    if (registered && file && info.isMain && realpathSync(root) === realpathSync(registered)
      && realpathSync(join(info.commonDir,'pullboard','board.sqlite')) === realpathSync(file)) return;
  } catch { /* Missing or foreign custody cannot become native source authority. */ }
  throw new Refused('COORDINATOR_ONLY', "automatic source advancement requires this board's registered native main checkout");
}

/** Capture patch, review and episode authority before any asynchronous gate or main merge. */
export function captureSourceAdvanceBasis(root, board, item) {
  requireNativeRoot(board, root);
  if (outsideSource(board, item.item_id)) throw new Refused('OUTSIDE_SANDBOX_REQUIRED', 'outside sources retain their isolated sandbox path; automatic native main merging is unavailable');
  const verdict = sourceAdvanceVerdict(board, item);
  const inputHead = sourceAdvanceChain(board, item).at(-1)?.head ?? verdict?.review?.head
    ?? prepareItemPatchReview(root, board, item, { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit, getItem }, { mergeMain: false }).commit;
  const basis = Object.freeze({ version: 1, board: identity(board), submitted: item.item_commit, status: item.item_status,
    previous: sourceAdvanceChain(board, item).at(-1)?.head ?? verdict?.review?.head ?? item.item_commit,
    inputHead, trunk: mainPolicy(root).commit, bar: item.item_frozen_digest, patchDigest: itemPatchDigest(board, item.item_id),
    episode: sourceAdvanceEpisode(board, item.item_id), reviewEpisode: sourceAdvanceReviewEpisode(board, item.item_id),
    reviewBy: item.item_review_by, reviewUntil: item.item_review_until, verdict: verdict?.verdict_id ?? null });
  BASES.add(basis);
  return basis;
}

/** Retain a checked composition in process; missing/crashed custody remains incomplete, never guessed green. */
export function prepareSourceAdvance(root, board, item, composition, gate, basis, selectors) {
  if (!BASES.has(basis) || basis.inputHead !== composition.inputHead || basis.trunk !== composition.trunk
    || sourceAdvanceCASProblem(board, itemById(board, item.item_id), basis)
    || !preparedSourceComposition(composition) || !gate?.isGreen || gate.deferred || gate.deferFullFallback || gate.deferredFiles
    || mainPolicy(root).commit !== composition.trunk) throw new Refused('SOURCE_ADVANCE_PROOF', 'the current main merge requires a genuine nondeferred green gate');
  const policy = mainPolicy(root);
  const plan = sourceAdvancePlan(composition.directory, policy.config, { base: composition.inputHead, changed: composition.changed, check: frozenCheck(item) }, selectors);
  const roles = [...(plan.criterion ? ['criterion'] : []), 'affected'];
  const ids = gate.proofReceiptIds.filter(Boolean);
  if (ids.length !== roles.length) throw new Refused('SOURCE_ADVANCE_PROOF', 'retain every actual frozen and affected phase receipt');
  const { boardReceiptStore, readGateReceipt } = board.runtimePorts.sourceAdvanceReceipts;
  const phases = ids.map((id, index) => {
    const receipt = readGateReceipt(boardReceiptStore(board), id);
    const role = roles[index];
    const command = sourceAdvanceHash(role === 'criterion' ? plan.criterion : plan.affected);
    if (!receipt || receipt.command !== command || receipt.head !== composition.head || receipt.tree !== composition.tree) {
      throw new Refused('SOURCE_ADVANCE_PROOF', 'the gate receipt does not bind the exact expected source and executed phase');
    }
    return { role, command, receipt };
  });
  if (git(composition.directory, ['rev-parse', 'HEAD']).trim() !== composition.head
    || git(composition.directory, ['rev-parse', 'HEAD^{tree}']).trim() !== composition.tree
    || git(composition.directory, ['status', '--porcelain']).trim()) throw new Refused('SOURCE_ADVANCE_SOURCE', 'the checked private source changed before completion');
  const verdict = sourceAdvanceVerdict(board, item);
  const proof = { ...basis, head: composition.head, tree: composition.tree,
    mergeTree: composition.mergeTree, paths: [...new Set([...(verdict?.review?.paths ?? []), ...composition.paths])].sort(),
    generated: [...composition.generated], selectionDigest: plan.selectionDigest, phases };
  const token = randomUUID();
  PREPARED.set(token, { board: identity(board), id: item.item_id, root, proof });
  if (PREPARED.size > 256) PREPARED.delete(PREPARED.keys().next().value);
  return { agentId: 'coordinator', token };
}

/** Convert private, exact origin custody into deterministic replay bytes immediately before native ordering. */
export function sealSourceAdvance(board, id, request) {
  const guardLandingWrite = board.runtimePorts?.sourceAdvanceReceipts?.guardLandingWrite;
  if (typeof guardLandingWrite !== 'function') throw new Refused('NO_POLICY', 'the native board root must supply source-advance landing protection');
  guardLandingWrite(board, request?.landingFence);
  const prepared = request?.agentId === 'coordinator' && PREPARED.get(request.token);
  if (!prepared || prepared.board !== identity(board) || prepared.id !== id
    || mainPolicy(prepared.root).commit !== prepared.proof.trunk) {
    throw new Refused('SOURCE_ADVANCE_STALE', 'the exact checked main changed or its native worker custody is unavailable');
  }
  requireNativeRoot(board, prepared.root);
  const { boardReceiptStore, readGateReceipt, receiptBody } = board.runtimePorts.sourceAdvanceReceipts;
  for (const phase of prepared.proof.phases ?? []) {
    const stored = readGateReceipt(boardReceiptStore(board), phase.receipt.id);
    if (!stored || receiptBody(stored) !== receiptBody(phase.receipt)) throw new Refused('SOURCE_ADVANCE_PROOF', 'restore the unchanged gate-owned receipt before completing this source advance');
    board.nativePorts.quarantine.sealQuarantineVerdict(board, stored);
  }
  return { agentId: 'coordinator', proof: prepared.proof };
}

/** Prepare a named return only from actual Git conflicts or the gate's own source-bound red receipt. */
export function prepareSourceAdvanceReturn(root, board, item, basis, { composition = null, gate = null } = {}, selectors) {
  if (!BASES.has(basis) || sourceAdvanceCASProblem(board, itemById(board, item.item_id), basis)
    || mainPolicy(root).commit !== basis.trunk) throw new Refused('SOURCE_ADVANCE_STALE', 'the failed source-advance episode changed');
  let proof;
  let action;
  if (!composition) {
    const files = sourceConflictFiles(root, basis.inputHead, basis.trunk);
    if (!files.length) throw new Refused('SOURCE_ADVANCE_SOURCE', 'a source return needs actual current Git conflicts');
    proof = { ...basis, outcome: 'conflict', files, phases: [] };
    action = { conflict: { files, trunk: basis.trunk }, note: `main conflicts with ${files.join(', ')}` };
  } else {
    if (!preparedSourceComposition(composition) || composition.inputHead !== basis.inputHead || composition.trunk !== basis.trunk
      || gate?.isGreen !== false || gate.deferred || gate.deferFullFallback || gate.deferredFiles) {
      throw new Refused('SOURCE_ADVANCE_PROOF', 'an unavailable or deferred run is incomplete, not a red source advance');
    }
    const plan = sourceAdvancePlan(composition.directory, mainPolicy(root).config, { base: basis.inputHead, changed: composition.changed, check: frozenCheck(item) }, selectors);
    const commands = [plan.criterion, plan.affected].filter(Boolean).map(sourceAdvanceHash);
    const { boardReceiptStore, readGateReceipt } = board.runtimePorts.sourceAdvanceReceipts;
    const phases = (gate.proofReceiptIds ?? []).filter(Boolean).map(id => ({ receipt: readGateReceipt(boardReceiptStore(board), id) }));
    const failed = phases.map(phase => phase.receipt).find(receipt => receipt?.version === 2 && receipt.head === composition.head
      && receipt.tree === composition.tree && receipt.main === basis.trunk && receipt.proof.sourceClean
      && receipt.proof.item === item.item_id && receipt.proof.seat === 'coordinator' && receipt.proof.frozenDigest === basis.bar
      && commands.includes(receipt.command) && !receiptBlockingGreen(receipt) && receipt.green === false && Number.isSafeInteger(receipt.proof.exitCode)
      && receipt.proof.exitCode !== 0 && receipt.proof.counts.failed > 0 && receipt.failures.length > 0);
    if (!failed) throw new Refused('SOURCE_ADVANCE_PROOF', 'infrastructure or unknown output cannot reopen an item as a measured test failure');
    const held = failed.blockingVerdict?.quarantines ?? [];
    const failures = [...new Map(failed.failures.filter(failure => !held.some(row => row.file === failure.file && row.name === failure.name)).map(row => [JSON.stringify([row.file,row.name]), row])).values()];
    const note = failures.map(row => `${row.file}: ${JSON.stringify(row.name)}`).join('; ') + `; merge commit ${composition.head}`;
    if (Buffer.byteLength(note, 'utf8') > 65536) throw new Refused('SOURCE_ADVANCE_PROOF', 'the complete measured failure list needs a bounded native diagnostic before return');
    action = { note, quotedLandingFailure: true };
    proof = { ...basis, outcome: 'red', head: composition.head, tree: composition.tree,
      files: [...new Set(failed.failures.map(row => row.file))].sort(), phases: [{ receipt: failed }] };
  }
  proof.action = action;
  const token = randomUUID();
  PREPARED.set(token, { board: identity(board), id: item.item_id, root, proof });
  return { agentId: 'coordinator', sourceAdvanceReturn: token };
}

/** Seal the exact ordinary reopen arguments together with their native episode and measured cause. */
export function sealSourceAdvanceReturn(board, id, request) {
  const sealed = sealSourceAdvance(board, id, { agentId: request?.agentId, token: request?.sourceAdvanceReturn, landingFence: request?.landingFence });
  if (!['conflict','red'].includes(sealed.proof.outcome)) throw new Refused('SOURCE_ADVANCE_PROOF', 'the worker did not prepare a source return');
  return { agentId: 'coordinator', ...sealed.proof.action, sourceAdvanceReturn: sealed.proof };
}
