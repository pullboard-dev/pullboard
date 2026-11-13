/** Review independence follows every claim and submit author, never just the latest owner [V1,B3]. */
import { ENGINE_VERSION } from "../../../state/index.js";
import { HISTORICAL_AUTHORS_ENGINE } from "../../../state/light.js";
import { Refused } from "../../../kernel/index.js";
import { PARENT_SESSION_ENGINE } from "../../../state/light.js";
import { PATCH_AUTHOR_IDENTITY_ENGINE } from "../../../state/light.js";
import { effectiveAgentParent } from "../../../seats/index.js";
import { standingProblem } from "../../../seats/index.js";

/** Read one item's indexed author history; older ordered moves retain their original current-builder rule. */
export function itemAuthors(board, item, { twoTierReviews, committedItemAuthors, reviewPatchAuthors }) {
  if (twoTierReviews(board)) return committedItemAuthors(board, item);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < HISTORICAL_AUTHORS_ENGINE) return [item.item_built_by].filter(Boolean);
  const authors = new Set([item.item_built_by, item.item_owner].filter(Boolean));
  for (const event of board.db.prepare("SELECT DISTINCT event_by FROM event WHERE item_id = ? AND event_kind IN ('claim', 'submit')").all(item.item_id)) {
    if (typeof event.event_by === 'string' && event.event_by) authors.add(event.event_by);
  }
  for (const author of reviewPatchAuthors(board, item)) authors.add(author.agentId);
  return [...authors];
}

/** Compare immutable author and parent identities without borrowing the current sender’s verifier credential. */
function authorIdentityProblem(board, item, reviewer, authors, reviewPatchAuthors) {
  if (authors.includes(reviewer)) return new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must');
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const direct = engine >= PATCH_AUTHOR_IDENTITY_ENGINE ? reviewPatchAuthors(board, item) : null;
  if (direct?.some(author => author.agentId === reviewer)) return new Refused('SELF_VERIFY', 'the builder never verifies its own work; another agent must');
  if (engine >= PARENT_SESSION_ENGINE && board.reviewIndependence !== 'off') { // review.independence, set from the repo config when the CLI opens the board
    const parent = effectiveAgentParent(board, reviewer);
    const snapshots = direct ?? reviewPatchAuthors(board, item);
    const session = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${reviewer}`)?.meta_value;
    if (authors.some(author => effectiveAgentParent(board, author) === parent)
        || snapshots.some(author => author.parentSession && author.parentSession === parent || session && author.session === session)) {
      return new Refused('SELF_SESSION_VERIFY', `this seat shares a parent session with an author of #${item.item_id}; ask a seat under another parent session to verify it`);
    }
  }
  return null;
}

/** A retained native verdict keeps its original authority but may not cover work by a newly related author. */
export function retainedVerifierIdentityProblem(board, item, reviewer, ports) {
  return authorIdentityProblem(board, item, reviewer, itemAuthors(board, item, ports), ports.reviewPatchAuthors);
}

/** Apply full author identity and current linked standing to every fresh review and queue selection. */
export function itemAuthorProblem(board, item, reviewer, ports) {
  const authors = itemAuthors(board, item, ports);
  const identity = authorIdentityProblem(board, item, reviewer, authors, ports.reviewPatchAuthors);
  if (identity) return identity;
  const { strictReviewProblem } = ports;
  const strict = strictReviewProblem(board, item, reviewer);
  if (strict) return strict;
  return (authors.length ? authors : [item.item_built_by])
    .map(author => standingProblem(board, reviewer, author, item.item_id)).find(Boolean) ?? null;
}
