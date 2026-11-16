/** Submit's edge stage: with submit.edgeFollowUps on, file one follow-up item linked to the submitted one for the import edges its diff adds (#8874) [C7]. */
import * as store from '../../../../../packages/store/index.js';
import { submitImportEdges } from '../../../../../packages/gate/index.js';
import { withBoard } from '../context.js';
import { ordered } from '../claim.js';

const FILED = /^Edge follow-up filed as #(\d+)/u;
const LISTED = 12;

/**
 * File the one follow-up for the import edges the diff from the claim head to `commit` adds, and note it on the item. Nothing
 * is filed when the setting is off, no edge was added, or an earlier submit of this item already filed one. Why: a new
 * import edge changes the architecture, and a reviewer should look at it once, not once per resubmit [C7].
 *
 * @param {any} ctx
 * @param {{ held: any, me: { id: string }, id: number, root: string, commit: string, claimHead: string, config: any }} at
 * @returns {Promise<number | null>} The follow-up's id, or null when none was filed.
 */
export async function fileEdgeFollowUp(ctx, { held, me, id, root, commit, claimHead, config }) {
  if (config.submit?.edgeFollowUps !== true || !claimHead) return null;
  const edges = submitImportEdges(root, config, { base: claimHead, commit });
  if (!edges.length) return null;
  return await withBoard(ctx, async board => {
    if (store.itemThread(board, id).some(entry => FILED.test(String(entry.type === 'fact' ? entry.text : '')))) return null;
    const listed = edges.slice(0, LISTED).map(edge => `${edge.from} -> ${edge.to}`).join('\n');
    const brief = `Filed by the submit of #${id}, which adds ${edges.length} import edge${edges.length === 1 ? '' : 's'}:\n${listed}${edges.length > LISTED ? `\n... and ${edges.length - LISTED} more` : ''}`;
    const followUp = await ordered(ctx, board, 'addItem', [{ by: me.id, lane: held.item_lane, title: `Review the ${edges.length} import edge${edges.length === 1 ? '' : 's'} added by #${id}`, parentId: id,
      criterion: `1. Each import edge listed in the brief is kept or removed, with the reason given [reasoning].`, brief, route: 'mid' }]);
    await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: `Edge follow-up filed as #${followUp}: ${edges.length} new import edge${edges.length === 1 ? '' : 's'} (submit.edgeFollowUps).` }]);
    return followUp;
  });
}
