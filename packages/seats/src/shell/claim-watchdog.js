/** A watchdog outside the seats nudges, then releases, a live seat's claim that shows no progress [B4,C7]. */

const MINUTE = 60_000;
/** A claim with no commit, submit or gate this long, while its seat is live, gets one nudge. */
export const WATCHDOG_IDLE_MS = 30 * MINUTE;
/** A nudged claim with still no progress after this long goes back to next. */
export const WATCHDOG_GRACE_MS = 10 * MINUTE;
/** A holder with a submit or gate this recently is never touched, whatever else it shows. */
export const WATCHDOG_KEEP_MS = 10 * MINUTE;

/**
 * Decide, for one pass, which claims to nudge and which to release. Pure: the caller supplies every observation
 * and applies the plan, so the same pass can be replayed against recorded events.
 *
 * @param {{item:number, owner:string, seatLive:boolean, lastCommitAt?:string|null, lastSubmitAt?:string|null,
 *   lastGateAt?:string|null, claimedAt:string}[]} claims - Each live claim with its latest progress instants.
 * @param {Map<number, string>} nudged - Item id to the instant its one nudge went out.
 * @param {number} now - The pass's clock reading in milliseconds.
 * @returns {{nudge:{item:number, owner:string}[], release:{item:number, owner:string, idleMs:number}[], keep:number[], cleared:number[]}}
 */
export function planClaimWatchdog(claims, nudged, now) {
  const plan = { nudge: [], release: [], keep: [], cleared: [] };
  for (const claim of claims) {
    const at = value => { const parsed = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
    const progress = Math.max(...[claim.lastCommitAt, claim.lastSubmitAt, claim.lastGateAt, claim.claimedAt].map(at).filter(value => value !== null), 0);
    const proof = Math.max(...[claim.lastSubmitAt, claim.lastGateAt].map(at).filter(value => value !== null), 0);
    const nudgedAt = at(nudged.get(claim.item));
    if (proof && now - proof < WATCHDOG_KEEP_MS) { plan.keep.push(claim.item); continue; }
    if (nudgedAt !== null && progress > nudgedAt) { plan.cleared.push(claim.item); continue; }
    if (!claim.seatLive || now - progress < WATCHDOG_IDLE_MS) continue;
    if (nudgedAt === null) plan.nudge.push({ item: claim.item, owner: claim.owner });
    else if (now - nudgedAt >= WATCHDOG_GRACE_MS) plan.release.push({ item: claim.item, owner: claim.owner, idleMs: now - progress });
  }
  return plan;
}

/**
 * Run one watchdog pass through injected ports: read claims, send each nudge once, release the ones past grace.
 *
 * @param {{claims:()=>object[], nudged:Map<number,string>, now:()=>number, nudge:(claim:object)=>void, release:(claim:object)=>void}} ports
 * @returns {ReturnType<typeof planClaimWatchdog>}
 */
export function runClaimWatchdog(ports) {
  const now = ports.now();
  const plan = planClaimWatchdog(ports.claims(), ports.nudged, now);
  for (const claim of plan.nudge) { ports.nudge(claim); ports.nudged.set(claim.item, new Date(now).toISOString()); }
  for (const claim of plan.release) { ports.release(claim); ports.nudged.delete(claim.item); }
  for (const item of plan.cleared) ports.nudged.delete(item);
  return plan;
}
