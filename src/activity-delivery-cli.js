/** Inbox and successful-submit delivery share one canonical receipt path [R2,N26,H16]. */
import * as store from './board.js';
import { budgetInbox } from './inbox-budget.js';
import { readActivityDelivery } from './activity-delivery-read.js';
import { handoffMoveProblem } from './handoff-state.js';
import { Refused } from './refused.js';
import {
  activityMainFiles,
  activityWorkingFiles,
  readActivityCursor,
  saveActivityCursor,
} from './activity-inbox.js';
import {
  agentDisplayName,
  evidenceLine,
  ordered,
  whoAmI,
  withBoard,
} from './cli.js';

/** Render digest counts, actionable references and direct coordination without expanding digest bodies. */
export function activityDeliveryLines({ shouts, agents, activity, budget }, config) {
  const lines = [];
  for (const shout of shouts) {
    const ask = shout.shout_decision ? `asks for a decision (#${shout.shout_id}; pullboard answer ${shout.shout_id} "..."): ` : '';
    const reply = shout.shout_answers ? `answers #${shout.shout_answers}: ` : '';
    lines.push(`${shout.shout_at.slice(0, 16)}  ${agentDisplayName(agents, config, shout.shout_from)} -> ${agentDisplayName(agents, config, shout.shout_to)}: ${ask}${reply}${shout.shout_text}`);
    if (shout.shout_evidence_kind) lines.push(`  ${evidenceLine(shout)}`);
  }
  for (const interrupt of activity.interrupts) lines.push(`interrupt ${interrupt.id}: ${interrupt.text}`);
  const direct = new Set(shouts.map(shout => shout.shout_id));
  for (const entry of activity.entries) if (!direct.has(entry.shout)) lines.push(`${entry.at.slice(0, 16)}  ${entry.text}`);
  for (const digest of activity.digests) lines.push(digest.text);
  if (activity.receipt?.recorded === false) lines.push(`activity delivery was not recorded: ${activity.receipt.message}`);
  if (budget?.summary) lines.push(budget.summary);
  if (!lines.length) lines.push('no new shouts or activity');
  return lines;
}

/** Persist bounded batches without advancing past an interrupt that a later batch has not yet recorded. */
async function recordIncluded(ctx, board, agentId, observation) {
  const groups = [];
  for (let offset = 0; offset < observation.fresh.length; offset += 1000) groups.push(observation.fresh.slice(offset, offset + 1000));
  if (!groups.length) groups.push([]);
  for (const [index, interrupts] of groups.entries()) {
    const remaining = groups.slice(index + 1).flat().map(interrupt => interrupt.eventId).filter(Number.isSafeInteger);
    const through = remaining.length ? Math.min(observation.through, Math.min(...remaining) - 1) : observation.through;
    await ordered(ctx, board, 'recordActivityDelivery', [{ agentId, interrupts, through,
      observedThrough: observation.observedThrough,
      ...(index === groups.length - 1 && observation.digestThrough !== undefined ? { digestThrough: observation.digestThrough } : {}) }]);
  }
}

/** Delivery records included interrupts; explicit recipient acknowledgement is a separate move. */
export async function deliverActivity(ctx, { actedIds = [], afterSubmit = false, directShouts = true } = {}) {
  const delivered = await withBoard(ctx, async board => {
    const me = whoAmI(ctx, board);
    if (actedIds.length) await ordered(ctx, board, 'actOnActivity', [{ agentId: me.id, ids: actedIds }]);
    const local = readActivityCursor(ctx.info.root, me.id, store.boardId(board));
    const projected = readActivityDelivery(board, me.id, { sessionStart: local.sessionStart, afterSubmit,
      workingFiles: builds => activityWorkingFiles(ctx.info.root, builds),
      changesForMain: (commit, detail) => activityMainFiles(ctx.info.root, commit, detail,
        { rowFiles: [ctx.config.spec, ctx.config.practice] }) });
    const { observation, newsShouts, shoutCursor, ...activity } = projected;
    // Pending obligations survive an output failure: delivery is not acknowledgement.
    const retired = handoffMoveProblem(board, me.id, 'recordActivityDelivery', [{ agentId: me.id }]);
    if (retired) activity.receipt = { recorded: false, code: retired.code, message: retired.message };
    const shouts = directShouts ? store.inbox(board, me.id, { through: shoutCursor, markRead: false })
      .filter(shout => !newsShouts.includes(shout.shout_id)) : [];
    const agents = store.listAgents(board);
    const diagnostic = 'activity cursor could not be saved; activity may repeat when you read inbox again';
    /** Reserve the possible persistence warning while selecting complete public groups. */
    const bound = () => budgetInbox({ shouts, agents, activity }, ctx.config.inbox.tokenBudget,
      result => activityDeliveryLines(result, ctx.config), [diagnostic]);
    let bounded = bound();
    const included = new Set(bounded.activity.interrupts.map(interrupt => interrupt.id));
    const withheld = observation.fresh.filter(interrupt => !included.has(interrupt.id))
      .map(interrupt => interrupt.eventId).filter(Number.isSafeInteger);
    const selected = { ...observation, fresh: observation.fresh.filter(interrupt => included.has(interrupt.id)),
      through: withheld.length ? Math.min(observation.through, Math.min(...withheld) - 1) : observation.through };
    if (!retired) {
      try { await recordIncluded(ctx, board, me.id, selected); }
      catch (error) {
        if (!(error instanceof Refused) || !['RELAY_RECOVERY_PENDING', 'RELAY_KEY_MISSING', 'AUTH_REQUIRED'].includes(error.code)) throw error;
        // A read remains available while canonical writes are fenced; its obligations remain unrecorded.
        activity.receipt = { recorded: false, code: error.code, message: error.message };
        bounded = bound();
      }
    }
    if (directShouts && !['RELAY_KEY_MISSING', 'AUTH_REQUIRED'].includes(activity.receipt?.code)) {
      const rendered = new Set(bounded.activity.interrupts.map(interrupt => interrupt.id));
      const withheldShouts = observation.fresh.filter(interrupt => !rendered.has(interrupt.id))
        .map(interrupt => interrupt.shout).filter(Number.isSafeInteger);
      const through = withheldShouts.length ? Math.min(shoutCursor, Math.min(...withheldShouts) - 1) : shoutCursor;
      store.inbox(board, me.id, { through });
    }
    return { ...bounded, local };
  });
  if (!['RELAY_KEY_MISSING', 'AUTH_REQUIRED'].includes(delivered.activity.receipt?.code) && !saveActivityCursor(delivered.local, delivered.activity.cursor)) {
    ctx.io.err('activity cursor could not be saved; activity may repeat when you read inbox again');
  }
  const { local, ...result } = delivered;
  return result;
}
