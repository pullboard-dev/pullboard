/** Board authority is the existing established SSH row-signature authority [E32,S17,H16]. */
import { Refused } from "../../../../../kernel/index.js";
import { boardId } from "../query.js";
import { headCommit } from "../../../../../git/index.js";
import { sha256 } from "../../../../../spec/index.js";
import { hasSignerFile } from "../../../../../spec/index.js";
import { isVerifiedSignoff } from "../../../../../spec/index.js";
import { signRowDecision } from "../../../../../spec/index.js";
import { verifyRowDecision } from "../../../../../spec/index.js";

/** Refuse missing or unverifiable board authority without an unsigned compatibility fallback. */
function unauthorized() { throw new Refused('BOARD_LINK_AUTH', 'obtain this board’s established approver signature through its configured signer authority'); }

/** Keep signature-domain fields identical for signing and verification. */
function fields(text) {
  const id = 'board-link:' + sha256(text);
  return { id, file: '<board-link>', kind: 'board-link', source: text, replacement: '', text: id,
    decision: 'approve', reason: '', note: '' };
}

/**
 * Supply the signer port from trusted board handles and their roots, never message-provided paths.
 * A future verified person-signature adapter can implement the same sign/verify interface.
 */
export function createSshBoardLinkAuthority(boards) {
  if (!Array.isArray(boards)) unauthorized();
  const roots = new Map();
  for (const entry of boards) {
    if (!entry?.board || typeof entry.root !== 'string') unauthorized();
    const id = boardId(entry.board);
    if (roots.has(id)) unauthorized();
    roots.set(id, entry.root);
  }
  /** Resolve only a caller-pinned board and insist that SSH authority is actually enabled. */
  function rootFor(id) {
    const root = roots.get(id);
    if (!root || !hasSignerFile(root)) unauthorized();
    return root;
  }
  return Object.freeze({
    /** Sign without appending or materializing any spec row or decision. */
    sign(id, text, { by, key } = {}) {
      const root = rootFor(id);
      return { ...signRowDecision(root, { ...fields(text), commit: headCommit(root), by,
        on: new Date().toISOString() }, key), boardId: id };
    },
    /** Verify the exact link-domain record using the board's complete established signer history. */
    verify(id, text, receipt) {
      const root = rootFor(id);
      if (!receipt?.signature || receipt.boardId !== id || receipt.type !== 'row-decision') unauthorized();
      for (const [key, value] of Object.entries(fields(text))) if (receipt[key] !== value) unauthorized();
      try { verifyRowDecision(root, receipt); }
      catch (error) { if (error instanceof Refused) unauthorized(); throw error; }
      if (!isVerifiedSignoff(receipt)) unauthorized();
      return true;
    },
  });
}
