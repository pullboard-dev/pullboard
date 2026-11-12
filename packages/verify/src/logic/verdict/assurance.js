import { reviewPatchAuthors } from '../../io/review/composition.js';
import { seatFamily } from '../../../../items/index.js';
import { committedItemAuthors } from '../../io/review/independence.js';
import { twoTierReviews } from '../../io/review/independence.js';
/** Immutable verdict assurance distinguishes recorded parent independence from procedural review [V1,B3]. */
import { ENGINE_VERSION } from '../../../../state/index.js';
import { PARENT_SESSION_ENGINE } from '../../../../state/light.js';
import { itemAuthors } from '../../../../items/index.js';
import { agentParent } from '../../../../seats/index.js';

/** Unknown parentage for any historical author limits assurance, even when review is procedurally allowed. */
export function reviewAssurance(board, item, reviewer) {
  const parent = agentParent(board, reviewer);
  const authors = itemAuthors(board, item, { reviewPatchAuthors, committedItemAuthors, twoTierReviews });
  return parent && authors.length && authors.every(author => {
    const built = agentParent(board, author);
    return built && built !== parent;
  }) ? 'independent' : 'procedural';
}

export { verdictAssurance } from './reviews.js';

/** Insert the immutable native verdict and, under engine 90, its assurance in the same board transaction. */
export function recordVerdict(board, item, { agentId, decision, reason, note, digest, head }) {
  const family = seatFamily(board, agentId);
  const inserted = board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note,
    verdict_commit, verdict_digest, verdict_head, verdict_verifier_family, verdict_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.item_id, agentId, decision, reason, note.trim(), item.item_commit,
    digest, head, family, board.clock.now().toISOString());
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < PARENT_SESSION_ENGINE) return null;
  const assurance = reviewAssurance(board, item, agentId);
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)')
    .run(`verdict_assurance:${inserted.lastInsertRowid}`, assurance);
  return assurance;
}
