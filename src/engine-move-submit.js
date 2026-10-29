import { submissionSize } from '../packages/state/index.js';
import { ENGINE_VERSION } from './machine.js';
import { SUBMISSION_PROOF_ENGINE } from './move-engine-constants.js';
import { submissionProof } from '../packages/state/index.js';
import { MERGE_ONLY_VERDICT_ENGINE } from './merge-only-verdict-engine.js';

/** Seal a submit's patches, proof, merge-only carry and size before any replica sees it [V4,H16]. */
export function prepareBefore(board, values, { ports, store }) {
  values[1] = ports.sealItemPatchSubmit(board, values[0], values[1]);
  if (ENGINE_VERSION >= SUBMISSION_PROOF_ENGINE) submissionProof(values[1]?.submissionProof);
  // Derive once before sealing; replicas never re-decide a recorded carry from their local objects.
  if (ENGINE_VERSION >= MERGE_ONLY_VERDICT_ENGINE && values[1]) {
    const carry = store.prepareMergeOnlySubmit(board, values[0], values[1], { getItem: store.getItem, acceptedVerdict: store.acceptedVerdict, identity: board.nativePorts });
    delete values[1].mergeOnly;
    if (carry) values[1].mergeOnly = carry;
  }
  submissionSize(values[1]?.submissionSize, values[1]?.commit);
}
