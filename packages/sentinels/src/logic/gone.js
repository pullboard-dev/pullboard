/** Opt-in coordinator maintenance uses ordinary ordered releases, never a second liveness rule. */
import { agentById } from "../../../store/index.js";

/** Release only observed gone holders of still-live build claims; reviews and holds remain intact. */
export async function releaseGoneClaims(ctx, board, me, ordered) {
  if (ctx.config.claims?.releaseGone !== true || me.id !== 'coordinator') return [];
  const released = [];
  const claims = board.db.prepare("SELECT item_id,item_owner FROM item WHERE item_status='claimed' AND item_lease_until>?")
    .all(board.clock.now().toISOString());
  for (const claim of claims) {
    const seat = agentById(board, claim.item_owner);
    if (seat?.presence !== 'gone' || !seat.heartbeatAt) continue;
    await ordered(ctx, board, 'release', [claim.item_id, me.id, '', { seat: seat.agent_id, lastSeen: seat.heartbeatAt }, 'BLOCKED']);
    released.push(claim.item_id);
  }
  return released;
}
