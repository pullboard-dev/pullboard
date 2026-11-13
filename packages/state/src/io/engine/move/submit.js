import { submissionSize } from '../../../../index.js';
import { Refused } from '../../../../../kernel/light.js';
import { ENGINE_VERSION } from '../../machine.js';
import { SUBMISSION_PROOF_ENGINE } from '../../../logic/move/constants.js';
import { submissionProof } from '../../../../index.js';
import { MERGE_ONLY_VERDICT_ENGINE } from '../../../logic/engines/merge-only-verdict-engine.js';

/** Seal a submit's patches, proof, merge-only carry and size before any replica sees it [V4,H16]. */
export function prepareBefore(board, values, { ports, store }) {
  values[1] = store.sealClauseInspection(board, values[0], values[1]);
  values[1] = store.sealStrictRenames(board, values[0], values[1]);
  values[1] = ports.sealKnownMainAutofile(board, values[0], values[1]);
  values[1] = ports.sealItemPatchSubmit(board, values[0], values[1]);
  if (ENGINE_VERSION >= SUBMISSION_PROOF_ENGINE) submissionProof(values[1]?.submissionProof, ENGINE_VERSION);
  // Derive once before sealing; replicas never re-decide a recorded carry from their local objects.
  if (ENGINE_VERSION >= MERGE_ONLY_VERDICT_ENGINE && values[1]) {
    const carry = store.prepareMergeOnlySubmit(board, values[0], values[1], { getItem: store.getItem, acceptedVerdict: store.acceptedVerdict, identity: board.nativePorts });
    delete values[1].mergeOnly;
    if (carry) values[1].mergeOnly = carry;
  }
  submissionSize(values[1]?.submissionSize, values[1]?.commit);
}

/** Missing immutable policy objects must not consume a relay receipt or cursor. */
export function replayBefore(board, args, { ports }) {
  const commit = args[1]?.clausePolicyCommit;
  if (!commit) return;
  if (!board.gitRoot) throw new Refused('NO_POLICY', 'the repository is unavailable for clause policy replay');
  ports.sandboxPolicyReads.policyAt(board.gitRoot, commit);
}
