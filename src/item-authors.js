import { committedItemAuthors } from './review-independence.js';
import { strictReviewProblem } from './review-independence.js';
import { twoTierReviews } from './review-independence.js';
/** Review independence follows every claim and submit author, never just the latest owner [V1,B3]. */
import { ENGINE_VERSION } from './engine-metadata.js';
import { itemPatchAuthors } from './item-patch-state.js';
import { HISTORICAL_AUTHORS_ENGINE } from './historical-authors-engine.js';
import { Refused } from './refused.js';
import { PARENT_SESSION_ENGINE } from './parent-session-engine.js';
import { effectiveAgentParent } from './seat-review-read.js';
import { standingProblem } from './seat-review-read.js';

/** Read one item's indexed author history; older ordered moves retain their original current-builder rule. */
export function itemAuthors(board, item) {
  if (twoTierReviews(board)) return committedItemAuthors(board, item);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < HISTORICAL_AUTHORS_ENGINE) return [item.item_built_by].filter(Boolean);
  const authors = new Set([item.item_built_by, item.item_owner].filter(Boolean));
  for (const event of board.db.prepare("SELECT DISTINCT event_by FROM event WHERE item_id = ? AND event_kind IN ('claim', 'submit')").all(item.item_id)) {
    if (typeof event.event_by === 'string' && event.event_by) authors.add(event.event_by);
  }
  for (const author of itemPatchAuthors(board, item.item_id)) authors.add(author.agentId);
  return [...authors];
}

/** Compare immutable author and parent identities without borrowing the current sender’s verifier credential. */
function authorIdentityProblem(board, item, reviewer, authors) {
  if (authors.includes(reviewer)) return new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= PARENT_SESSION_ENGINE) {
    const parent = effectiveAgentParent(board, reviewer);
    const snapshots = itemPatchAuthors(board, item.item_id);
    const session = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${reviewer}`)?.meta_value;
    if (authors.some(author => effectiveAgentParent(board, author) === parent)
        || snapshots.some(author => author.parentSession && author.parentSession === parent || session && author.session === session)) {
      return new Refused('SELF_SESSION_VERIFY', `this seat shares a parent session with an author of #${item.item_id}; ask a seat under another parent session to verify it`);
    }
  }
  return null;
}

/** A retained native verdict keeps its original authority but may not cover work by a newly related author. */
export function retainedVerifierIdentityProblem(board, item, reviewer) {
  return authorIdentityProblem(board, item, reviewer, itemAuthors(board, item));
}

/** Apply full author identity and current linked standing to every fresh review and queue selection. */
export function itemAuthorProblem(board, item, reviewer) {
  const authors = itemAuthors(board, item);
  const identity = authorIdentityProblem(board, item, reviewer, authors);
  if (identity) return identity;
  const strict = strictReviewProblem(board, item, reviewer);
  if (strict) return strict;
  return (authors.length ? authors : [item.item_built_by])
    .map(author => standingProblem(board, reviewer, author, item.item_id)).find(Boolean) ?? null;
}
