import { listThinRead } from '../../../../../packages/config/light.js';
import { typedFieldsEnabled } from '../../../../../packages/config/light.js';
import { hunkFreshnessEnabled } from '../../../../../packages/config/light.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { thinListRows } from '../list/thin.js';
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
  foreignStates,
  itemLine,
} from '../read.js';

/** Query-only dispatch defers the explicit native provider until a genuine write fallback. */
export const nativeBoardRequired = false;

/** Run `pullboard list` and return its exit code. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  // A --field filter reads the field tables, so it takes the full path and needs items.typedFields [C7,#9353].
  if (values.field !== undefined && !typedFieldsEnabled()) throw new Refused('FIELDS_OFF', 'typed item fields are off', 'turn on items.typedFields in the machine settings first');
  // With list.thinRead on, the thin door serves the rows; null (no readable board, or one a read must not open) takes the full path below [C7,#9089].
  const thin = listThinRead() && values.field === undefined ? thinListRows({ cwd: io.cwd, lane: first, all: values.all, clock: ctx.clock }) : null;
  const { items, agents, merging, foreign = new Map(), needsRescope = [], fieldIndex } = thin ?? await withBoardRead(ctx, async (board) => {
    const rows = store.listItems(board, { lane: first, all: values.all });
    const items = rows.map(verdictProjector(ctx.info.root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef, hunkKeyed: hunkFreshnessEnabled() }).project);
    // JSON returns these complete rows; agent names and merge labels belong only to the text rendering.
    const fieldIndex = values.field === undefined ? undefined : (await import('../../../../../packages/store/index.js')).fieldIndex(board, { enabled: true });
    if (values.json) return { items, fieldIndex, needsRescope: store.allItemsNeedingRescope(board) };
    return { fieldIndex, needsRescope: store.allItemsNeedingRescope(board), items, agents: store.listAgents(board), foreign: new Map(await Promise.all(rows.map(async item => [item.item_id, await foreignStates(board, item, async () => (await import('../../../../../packages/store/index.js')).foreignDependencyStates)]))),
      merging: new Set(rows.filter(item => !['verified', 'withdrawn'].includes(item.item_status) && mainMergeFor(board, item.item_id)).map(item => item.item_id)) };
  });
  const routed = items.filter((item) => !values.route || item.item_route === values.route);
  const filtered = fieldIndex ? (await import('../../../../../packages/items/light.js')).filterByField(routed, values.field, fieldIndex) : routed;
  if (values.json) io.result({ items: filtered, needsRescope });
  else if (!filtered.length) io.say(values.all ? 'no items yet' : 'nothing open; --all shows closed items');
  else filtered.forEach((item) => io.say(itemLine(item, (id) => agentDisplayName(agents, ctx.config, id), merging.has(item.item_id), foreign.get(item.item_id))));
  // Items next is holding back from a lane and route after a release, each with its reason and age (#3742).
  if (!values.json) for (const entry of needsRescope) io.say(`needs re-scope: #${entry.id} is not offered to ${entry.lane} at the ${entry.route} route; ${entry.reasons.join('; ')}`);
  return 0;
}
