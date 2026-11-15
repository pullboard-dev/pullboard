import { trunkRef } from '../../../../../packages/sandbox/light.js';
import { withBoardRead } from '../board/read.js';
/** The pullboard list command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/light.js';
import {
  mainMergeFor,
} from '../../../../../packages/merge/light.js';
import {
  verdictProjector,
} from '../../../../../packages/verify/read.js';
import {
  agentDisplayName,
  context,
  itemLine,
} from '../read.js';

/** Query-only dispatch defers the explicit native provider until a genuine write fallback. */
export const nativeBoardRequired = false;

/** Run `pullboard list` and return its exit code. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  const { items, agents, merging, needsRescope = [] } = await withBoardRead(ctx, (board) => {
    const rows = store.listItems(board, { lane: first, all: values.all });
    const items = rows.map(verdictProjector(ctx.info.root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef }).project);
    // JSON returns these complete rows; agent names and merge labels belong only to the text rendering.
    if (values.json) return { items };
    return { needsRescope: store.allItemsNeedingRescope(board), items, agents: store.listAgents(board),
      merging: new Set(rows.filter(item => !['verified', 'withdrawn'].includes(item.item_status) && mainMergeFor(board, item.item_id)).map(item => item.item_id)) };
  });
  const filtered = items.filter((item) => !values.route || item.item_route === values.route);
  if (values.json) io.result({ items: filtered });
  else if (!filtered.length) io.say(values.all ? 'no items yet' : 'nothing open; --all shows closed items');
  else filtered.forEach((item) => io.say(itemLine(item, (id) => agentDisplayName(agents, ctx.config, id), merging.has(item.item_id))));
  // Items next is holding back from a lane and route after a release, each with its reason and age (#3742).
  if (!values.json) for (const entry of needsRescope) io.say(`needs re-scope: #${entry.id} is not offered to ${entry.lane} at the ${entry.route} route; ${entry.reasons.join('; ')}`);
  return 0;
}
