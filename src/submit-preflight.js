/**
 * Submit preflight (#924): the board's own submit guards, run before any check or test. A refusal that no test
 * result can change (HEAD_NOT_NEW, NOT_YOURS, a pending refreeze, open children) used to come back only after the
 * whole proof ran; on 19 Oct #890 spent 679 s before HEAD_NOT_NEW. Here the real submit move runs in a transaction
 * that always rolls back, with a stand-in proof, so every board guard decides now and nothing is recorded.
 */

/** Thrown to roll back a preflight that passed; never escapes this module. */
const PASSED = Symbol('submit preflight passed');

/** A deferred proof that names no files: enough for the move's shape, never recorded. */
const STAND_IN_PROOF = Object.freeze({ version: 1, files: [], full: false, deferred: true, reason: 'submit preflight; no proof has run yet' });

/**
 * Refuse now, exactly as the submit itself would, when a board guard that needs no test result refuses.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, tree: string }} submission
 */
export function submitPreflight(board, id, { agentId, commit, tree }, { atomic, submit }) {
  try {
    atomic(board, () => {
      submit(board, id, { agentId, commit, tree, files: [], submissionProof: STAND_IN_PROOF });
      throw PASSED;
    });
  } catch (error) {
    if (error !== PASSED) throw error;
  }
}
