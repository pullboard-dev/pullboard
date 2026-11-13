/** Seal an owner wait only at the authenticated native source origin [B3,L1,V4]. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  repoInfo,
  headCommit,
  headTree,
  isClean,
  tryGit,
  contains,
} from '../../../git/index.js';
import {
  itemPolicy,
  submissionPaths,
  dependencySnapshots,
  policyGit,
  mainPolicy,
} from '../../../sandbox/index.js';
import { laneOf } from '../../../seats/index.js';
import {
  getItem as itemById,
  boundProofReceipt,
  submitHandoff,
  boardFilePath,
} from '../../../store/index.js';
import { Refused } from '../../../kernel/index.js';

/** Derive routing data from the board's repository and the same strict lane refusal, never supplied paths. */
export function sealOwnershipWait(board, id, request) {
  const item = itemById(board, id), root = request?.root;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (typeof root !== 'string' || !file || realpathSync(boardFilePath(repoInfo(root).commonDir)) !== realpathSync(file)
    || headCommit(root) !== request.commit || headTree(root) !== request.tree || !isClean(root)) {
    throw new Refused('OWNERSHIP_WAIT_SOURCE', 'ownership routing must seal the clean proved source in this board\'s native item context');
  }
  const workerRoot = board.enginePorts.submitHandoffBoardRoot(board, id, request.agentId);
  const captured = submitHandoff(board, id);
  const worker = captured?.state === 'running' && captured.agentId === request.agentId
    && captured.executionCommit === request.commit && captured.executionTree === request.tree
    && captured.digest === item.item_frozen_digest && captured.main === request.main
    && typeof workerRoot === 'string' && realpathSync(root) === realpathSync(workerRoot);
  const nativeMain = mainPolicy(root).commit;
  if (request.main !== nativeMain && !(worker && contains(root, request.main, nativeMain))) {
    throw new Refused('OWNERSHIP_WAIT_SOURCE', "ownership routing needs current main or the captured worker's still-ancestral pinned main");
  }
  if (!worker) {
    const source = board.enginePorts.sealSubmitHandoffQueue(board, id, {
      agentId: request.agentId, main: request.main, commit: request.commit, tree: request.tree,
      executionCommit: request.commit, executionTree: request.tree,
      companionDigest: board.enginePorts.itemPatchDigest(board, id, request.commit),
    }, { sourceOnly: true });
    if (realpathSync(root) !== realpathSync(source.root)) {
      throw new Refused('OWNERSHIP_WAIT_SOURCE', 'route only from the registered builder, its native item folder or its exact captured worker');
    }
  }
  let refused;
  try { submissionPaths(root, item, request.commit, { mainCommit: request.main, dependencies: dependencySnapshots(board.db, item) }); }
  catch (error) { if (error.code !== 'OUTSIDE_LANE' || !Array.isArray(error.paths)) throw error; refused = error; }
  if (!refused?.paths.length) throw new Refused('OWNERSHIP_WAIT_SOURCE', 'this source has no remaining lane-ownership refusal; use ordinary submit');
  const policy = itemPolicy(root, item);
  const paths = [...new Set(refused.paths)].sort();
  const owners = [...new Set(paths.map(path => laneOf(policy.config, path)))].sort();
  const diff = policyGit(root, ['diff', '--binary', '--full-index', request.main, request.commit, '--', ...paths]);
  if (!diff) throw new Refused('OWNERSHIP_WAIT_SOURCE', 'the ownership refusal must retain its exact nonempty diff');
  if (!Array.isArray(request.receiptIds) || !request.receiptIds.length || new Set(request.receiptIds).size !== request.receiptIds.length) {
    throw new Refused('OWNERSHIP_WAIT_PROOF', 'supply the distinct recorded receipts from this native submission');
  }
  const receipts = request.receiptIds.map(receiptId => boundProofReceipt(board, { receiptId }));
  const currentJob = submitHandoff(board, id);
  const job = currentJob?.state === 'running' && currentJob.agentId === request.agentId
    && currentJob.executionCommit === request.commit && currentJob.executionTree === request.tree
    && currentJob.digest === item.item_frozen_digest && currentJob.main === request.main ? currentJob.id : null;
  const key = createHash('sha256').update(JSON.stringify([id, request.commit, item.item_frozen_digest, paths, diff])).digest('hex');
  const sourceRef = `refs/pullboard/ownership-waits/${id}/${key}`;
  const existing = tryGit(root, ['rev-parse', '--verify', sourceRef]);
  if (existing.status === 0 && existing.stdout.trim() !== request.commit) throw new Refused('OWNERSHIP_WAIT_SOURCE', 'the preserved ownership source ref changed; keep it and ask the coordinator to inspect custody');
  if (existing.status !== 0) policyGit(root, ['update-ref', sourceRef, request.commit, '0'.repeat(request.commit.length)]);
  return { version: 1, key, item: id, agentId: request.agentId, commit: request.commit, tree: request.tree,
    main: request.main, job, digest: item.item_frozen_digest, policy: policy.commit, paths, owners,
    lanes: [...new Set(['coordinator', ...Object.keys(policy.config.lanes)])], diff, sourceRef, receipts };
}

