/** Inbox and successful-submit delivery share one canonical receipt path [R2,N26,H16]. */
import * as store from '../../../../store/index.js';
import { budgetInbox } from '../../logic/budget.js';
import { readActivityDelivery } from './read.js';
import { handoffMoveProblem } from '../../../../state/light.js';
import { Refused } from '../../../../kernel/index.js';
import {
  activityMainFiles,
  batchMainFiles,
  activityWorkingFiles,
  readActivityCursor,
  saveActivityCursor,
} from '../inbox.js';

/** Render bounded groups using the caller-owned actor and evidence presentation ports. */
export function activityDeliveryLines({ shouts, agents, activity, budget }, config, { agentDisplayName, evidenceLine } = {}) {
  const lines = [];
  for (const shout of shouts) {
    const ask = shout.shout_decision ? `asks for a decision (#${shout.shout_id}; pullboard answer ${shout.shout_id} "..."): ` : '';
    const reply = shout.shout_answers ? `answers #${shout.shout_answers}: ` : '';
    lines.push(`${shout.shout_at.slice(0, 16)}  ${agentDisplayName(agents, config, shout.shout_from)} -> ${agentDisplayName(agents, config, shout.shout_to)}: ${ask}${reply}${shout.shout_text}`);
    if (shout.shout_evidence_kind) lines.push(`  ${evidenceLine(shout)}`);
  }
  for (const interrupt of activity.interrupts) lines.push(`interrupt ${interrupt.id}: ${interrupt.text}`);
  if (activity.pending?.length) {
    const shown = activity.pending.slice(0, 20).join(',');
    const rest = activity.pending.length > 20 ? ` and ${activity.pending.length - 20} more` : '';
    lines.push(`${activity.pending.length} delivered interrupt${activity.pending.length === 1 ? '' : 's'} still unacted: ${shown}${rest}; clear with pullboard inbox --acted-on <ids>`);
  }
  const direct = new Set(shouts.map(shout => shout.shout_id));
  for (const entry of activity.entries) if (!direct.has(entry.shout)) lines.push(`${entry.at.slice(0, 16)}  ${entry.text}`);
  for (const digest of activity.digests) lines.push(digest.text);
  if (activity.receipt?.recorded === false) lines.push(`activity delivery was not recorded: ${activity.receipt.message}`);
  if (budget?.summary) lines.push(budget.summary);
  if (!lines.length) lines.push('no new shouts or activity');
  return lines;
}

/**
 * Whether recording this observation would change nothing: no fresh interrupt and no digest past the recorded cursor.
 *
 * The canonical move saves only new interrupts or a later digest, so an unchanged read records nothing; skipping it
 * spares the board lock and the lapsed-claim capture every ordered write runs first, which cost seconds per inbox (#2421).
 */
function deliveryUnchanged(board, agentId, observation) {
  if (observation.fresh.length) return false;
  if (observation.digestThrough === undefined) return true;
  return observation.digestThrough <= store.activityDeliveryState(board, agentId).digestThrough;
}

/** Persist bounded batches without advancing past an interrupt that a later batch has not yet recorded. */
async function recordIncluded(ctx, board, agentId, observation, { ordered }) {
  if (deliveryUnchanged(board, agentId, observation)) return;
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

/**
 * Queue the mark for the shouts an inbox read showed instead of writing it, when inbox.batchedMarks is on.
 *
 * Why: an inline mark is one board write per read; queued, many reads' marks flush in one batch (#8942).
 */
function enqueueShoutMark(board, agentId, through) {
  const shown = store.inbox(board, agentId, { through, markRead: false }).map(shout => shout.shout_id);
  if (shown.length) store.enqueueInboxMark(board, agentId, Math.max(...shown));
}

/**
 * Delivery records included interrupts through caller-owned CLI ports; explicit acknowledgement stays separate.
 *
 * A read with nothing to record runs on a read-only board first, so it never queues behind another seat's write;
 * only a read that must record delivery or mark shouts read opens the board for writing (#2421).
 */
export async function deliverActivity(ctx, { actedIds = [], afterSubmit = false, directShouts = true } = {}, ports) {
  const { withBoard, withBoardRead, whoAmI, ordered } = ports;
  const batched = ctx.config.inbox.batchedMarks === true;
  /** Project and, unless `quiet`, record one delivery; a quiet pass returns null where it would have to write. */
  const deliverOn = async (board, quiet) => {
    const me = whoAmI(ctx, board);
    // Marks queued by an earlier read go out in one batched write before this read selects its shouts (#9116).
    if (batched && !quiet) store.flushInboxMarks(board);
    if (actedIds.length) await ordered(ctx, board, 'actOnActivity', [{ agentId: me.id, ids: actedIds }]);
    const local = readActivityCursor(ctx.info.root, me.id, store.boardId(board));
    let mainBatch = null;
    const projected = readActivityDelivery(board, me.id, { sessionStart: local.sessionStart, afterSubmit,
      workingFiles: builds => activityWorkingFiles(ctx.info.root, builds),
      // The landings' file lists are read together before the projection asks for them one at a time (#3252).
      prepareMainChanges: pairs => { mainBatch = batchMainFiles(ctx.info.root, pairs); },
      changesForMain: (commit, detail) => activityMainFiles(ctx.info.root, commit, detail,
        { rowFiles: [ctx.config.spec, ctx.config.practice], batch: mainBatch }) });
    const { observation, newsShouts, shoutCursor, ...activity } = projected;
    // A delivered, unacted interrupt is an obligation, not news: a repeat read names its id once, never its text again [#1885].
    const fresh = new Set(observation.fresh.map(interrupt => interrupt.id));
    activity.pending = activity.interrupts.filter(interrupt => !fresh.has(interrupt.id)).map(interrupt => interrupt.id);
    activity.interrupts = activity.interrupts.filter(interrupt => fresh.has(interrupt.id));
    // Pending obligations survive an output failure: delivery is not acknowledgement.
    const retired = handoffMoveProblem(board, me.id, 'recordActivityDelivery', [{ agentId: me.id }]);
    if (retired) activity.receipt = { recorded: false, code: retired.code, message: retired.message };
    const shouts = directShouts ? store.inbox(board, me.id, { through: shoutCursor, markRead: false })
      .filter(shout => !newsShouts.includes(shout.shout_id)) : [];
    // Seat names render only shouts; a read with none never lists every seat on the board (#2421).
    const agents = shouts.length ? store.listAgents(board) : [];
    const diagnostic = 'activity cursor could not be saved; activity may repeat when you read inbox again';
    /** Reserve the possible persistence warning while selecting complete public groups. */
    const bound = () => budgetInbox({ shouts, agents, activity }, ctx.config.inbox.tokenBudget,
      result => activityDeliveryLines(result, ctx.config, ports), [diagnostic]);
    let bounded = bound();
    const included = new Set(bounded.activity.interrupts.map(interrupt => interrupt.id));
    const withheld = observation.fresh.filter(interrupt => !included.has(interrupt.id))
      .map(interrupt => interrupt.eventId).filter(Number.isSafeInteger);
    const selected = { ...observation, fresh: observation.fresh.filter(interrupt => included.has(interrupt.id)),
      through: withheld.length ? Math.min(observation.through, Math.min(...withheld) - 1) : observation.through };
    if (quiet && !retired && !deliveryUnchanged(board, me.id, selected)) return null;
    const markThrough = () => {
      const rendered = new Set(bounded.activity.interrupts.map(interrupt => interrupt.id));
      const withheldShouts = observation.fresh.filter(interrupt => !rendered.has(interrupt.id))
        .map(interrupt => interrupt.shout).filter(Number.isSafeInteger);
      return withheldShouts.length ? Math.min(shoutCursor, Math.min(...withheldShouts) - 1) : shoutCursor;
    };
    if (quiet) {
      // Marking shouts read is a write, so a quiet pass hands any unread shout to the writing pass.
      if (directShouts && store.inbox(board, me.id, { through: markThrough(), markRead: false }).length) return null;
      return { ...bounded, local };
    }
    if (!retired) {
      try { await recordIncluded(ctx, board, me.id, selected, ports); }
      catch (error) {
        if (!(error instanceof Refused) || !['RELAY_RECOVERY_PENDING', 'RELAY_KEY_MISSING', 'AUTH_REQUIRED'].includes(error.code)) throw error;
        // A read remains available while canonical writes are fenced; its obligations remain unrecorded.
        activity.receipt = { recorded: false, code: error.code, message: error.message };
        bounded = bound();
      }
    }
    if (directShouts && !['RELAY_KEY_MISSING', 'AUTH_REQUIRED'].includes(activity.receipt?.code)) {
      if (batched) {
        enqueueShoutMark(board, me.id, markThrough());
        // The command owns the background worker, so a queued mark outlives this process (#9117).
        ports.handOffMarks?.(ctx, store.takeInboxMarks(board));
      }
      else store.inbox(board, me.id, { through: markThrough() });
    }
    return { ...bounded, local };
  };
  let delivered = null;
  if (!actedIds.length && withBoardRead) {
    try { delivered = await withBoardRead(ctx, board => deliverOn(board, true)); }
    catch (error) { if (!store.writeRefused(error)) throw error; }
  }
  delivered ??= await withBoard(ctx, board => deliverOn(board, false));
  if (!['RELAY_KEY_MISSING', 'AUTH_REQUIRED'].includes(delivered.activity.receipt?.code) && !saveActivityCursor(delivered.local, delivered.activity.cursor)) {
    ctx.io.err('activity cursor could not be saved; activity may repeat when you read inbox again');
  }
  const { local, ...result } = delivered;
  return result;
}
